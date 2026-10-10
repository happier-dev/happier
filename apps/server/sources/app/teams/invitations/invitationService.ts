import {
    deriveTeamInvitationStateV1,
    decodeTeamInvitationsCursorV1,
    encodeTeamInvitationsCursorV1,
    maskTeamInvitationRecipientEmail,
    teamInvitationsQueryKeyV1,
    type TeamInvitationAdmissibleRoleV1,
    type TeamInvitationPreviewResultV1,
    type TeamInvitationPreviewV1,
    type TeamInvitationRowV1,
    type TeamInvitationStateV1,
} from "@happier-dev/protocol/teams";
import { createHash } from "node:crypto";
import type { Tx } from "@/storage/inTx";
import type { SessionHistoryAccess } from "@/storage/enums.generated";
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from "@/storage/queue/repeatKey";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { projectTeamLogoRefV1 } from "../projections";
import { publishTeamChangedInTx } from "../teamChanges";
import {
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamActorContext,
    type TeamOperationAuthenticationContext,
} from "../actorContext";
import {
    activeTeamInvitationWhere,
    createTeamInvitationInTx,
    readActiveTeamInvitationAdmissionReferenceInTx,
    readTeamInvitationByTokenHashInTx,
    reissueTeamInvitationInTx,
    revokeTeamInvitationInTx,
    type TeamInvitationRecord,
} from "./invitationLifecycle";
import { projectTeamInvitationRowV1 } from "./project";
import { digestTeamInvitationToken, mintTeamInvitationToken, tryDigestTeamInvitationToken } from "./token";
import { isTeamMembershipAdmissionEnabled } from "../memberships/membershipService";

/**
 * The authorized invitation operations.
 *
 * Every entry point re-resolves the actor's current Team capability inside the caller's
 * transaction, so a stale client projection, a demotion between render and submit, or a
 * Team archived mid-flight cannot admit a mutation. Routes map these typed results to
 * HTTP; they hold no role comparison of their own.
 *
 * Authority here is Team capability only. Home administration deliberately does not
 * confer invitation rights: Home governance authorizes governance, never Team
 * membership or content.
 */

/**
 * Authorization outcomes shared by every invitation operation. Operations declare only
 * the errors they can actually produce, so a transport cannot be written to handle a
 * status its route can never return.
 */
export type TeamInvitationAuthorityError =
    | "team_not_found"
    | "team_archived"
    | "forbidden"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "invalid_team_cursor";
export type TeamInvitationTargetError = TeamInvitationAuthorityError | "invitation_not_found";
export type TeamInvitationServiceError = TeamInvitationTargetError | "invitation_not_active";

/**
 * Every error any invitation operation can produce. Individual operations still
 * declare only their own narrower union; this exists so the shared result type and
 * the route's single translation table can be exhaustive over all of them.
 */
export type TeamInvitationAnyError =
    | TeamInvitationServiceError
    | "request_conflict"
    | "email_delivery_unavailable";

export type TeamInvitationServiceResult<T, E extends TeamInvitationAnyError> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: E }>;

function denied<E extends TeamInvitationAnyError>(error: E): Readonly<{ ok: false; error: E }> {
    return { ok: false, error };
}

/**
 * Distinguishes "you may not" from "this Team is archived" so the UI can explain the
 * real reason. An archived Team withdraws `manageInvitations` at the evaluator, which
 * would otherwise surface as a bare permission error.
 *
 * The actor's Team, Account lifecycle, membership and capabilities come from the one
 * canonical Team actor context. Reading them here would be a second lookup and a
 * second composition of the same decision, able to disagree with every other Team
 * service about the same actor.
 */
async function requireInvitationManagerInTx(
    tx: Tx,
    input: Partial<TeamOperationAuthenticationContext> & Readonly<{ teamId: string; actorAccountId: string }>,
): Promise<TeamInvitationServiceResult<TeamActorContext, TeamInvitationAuthorityError>> {
    const context = await resolveTeamActorContextInTx(tx, input);
    if (!context) return denied("team_not_found");
    if (!context.teamCapabilities.manageInvitations) {
        // Only someone who may already see the Team learns that it is merely archived;
        // anyone else gets the same answer they would get for a Team they cannot see.
        if (context.team.archivedAt !== null && context.teamCapabilities.viewTeam) {
            return denied("team_archived");
        }
        return denied("forbidden");
    }

    const qualified = await qualifyTeamOperationAuthenticationInTx(tx, {
        context,
        ...input,
    });
    if (!qualified.ok) return denied(qualified.error);
    return { ok: true, value: context };
}

/**
 * The dedupe records for one invitation intent.
 *
 * Keys are scoped to the operation, the actor, and the Home-local target, so two
 * managers who happen to generate the same key never collide and a key from one
 * Team can never replay into another. This is the existing repeat-key facility
 * scoped to these operations — not a general Action ledger, and emphatically not
 * a bearer store: the recorded value is a payload digest and a row id, never a
 * token. A retry therefore recovers *which invitation exists*, and the secret it
 * cannot recover is precisely why the answer directs the manager to reissue.
 */
function invitationCreateRequestKey(input: Readonly<{
    actorAccountId: string;
    teamId: string;
    requestKey: string;
}>): string {
    return `teams.invitations.create:${input.actorAccountId}:${input.teamId}:${input.requestKey}`;
}

function invitationReissueRequestKey(input: Readonly<{
    actorAccountId: string;
    teamId: string;
    invitationId: string;
    requestKey: string;
}>): string {
    return `teams.invitations.reissue:${input.actorAccountId}:${input.teamId}:${input.invitationId}:${input.requestKey}`;
}

function invitationPayloadDigest(payload: readonly (string | null)[]): string {
    return createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
}

/**
 * Reads a recorded intent and returns the row it committed.
 *
 * A recorded key whose digest disagrees is a different intent wearing the same
 * key: that is a client error, never a silent second invitation and never a
 * silent overwrite of the first. A recorded row that has since disappeared is
 * still not permission to mint another bearer.
 */
async function replayRecordedInvitationInTx(
    tx: Tx,
    input: Readonly<{ dedupeKey: string; digest: string; now: Date }>,
): Promise<
    | Readonly<{ status: "fresh" }>
    | Readonly<{ status: "conflict" }>
    | Readonly<{ status: "replayed"; record: TeamInvitationRecord }>
> {
    const recorded = await fetchRepeatKey(tx, input.dedupeKey, input.now);
    if (recorded === null) return { status: "fresh" };

    const separator = recorded.indexOf(":");
    const recordedDigest = separator < 0 ? recorded : recorded.slice(0, separator);
    const recordedInvitationId = separator < 0 ? "" : recorded.slice(separator + 1);
    if (recordedDigest !== input.digest || !recordedInvitationId) return { status: "conflict" };

    const record = await tx.teamInvitation.findUnique({ where: { id: recordedInvitationId } });
    if (!record) return { status: "conflict" };
    return { status: "replayed", record };
}

export type CreateTeamInvitationResult = Readonly<{
    invitation: TeamInvitationRowV1;
    /**
     * The raw bearer, returned exactly once. The caller decides its egress: a human
     * manager receives a join link, an email-bound invitation hands it only to the
     * mail boundary, and an egress-restricted automated caller receives neither.
     *
     * `null` means this answer is the replay of an already committed intent. The
     * bearer was never stored and cannot be reconstructed from its digest, so the
     * caller recovers by explicit reissue rather than by a replayed secret.
     */
    token: string | null;
    /** Read in the deciding transaction, for the mail boundary's subject line. */
    teamName: string;
}>;

export type CreateTeamInvitationError = TeamInvitationAuthorityError
    | "request_conflict"
    | "email_delivery_unavailable";

export async function createTeamInvitationForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        role: TeamInvitationAdmissibleRoleV1;
        historyAccess: SessionHistoryAccess;
        recipientEmailNormalized: string | null;
        /** Whether a newly minted email-bound bearer can be delivered now. */
        emailDeliveryAvailable: boolean;
        /** The caller's retry identity, so a lost response cannot mint two bearers. */
        requestKey: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamInvitationServiceResult<CreateTeamInvitationResult, CreateTeamInvitationError>> {
    const authorized = await requireInvitationManagerInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
        ...input.authentication,
    });
    if (!authorized.ok) return authorized;

    const now = await readTransactionDatabaseTime(tx);
    const historyAccess = input.role === "guest" ? "from_membership" : input.historyAccess;
    const dedupeKey = invitationCreateRequestKey(input);
    // The recipient is digested in its normalized form, so the same address typed
    // with different casing is the same intent rather than a false conflict.
    const digest = invitationPayloadDigest([
        input.role,
        historyAccess,
        input.recipientEmailNormalized,
    ]);

    const recorded = await replayRecordedInvitationInTx(tx, { dedupeKey, digest, now });
    if (recorded.status === "conflict") return denied("request_conflict");
    if (recorded.status === "replayed") {
        return {
            ok: true,
            value: {
                invitation: projectTeamInvitationRowV1(recorded.record, now),
                token: null,
                teamName: authorized.value.team.name,
            },
        };
    }

    if (input.recipientEmailNormalized !== null && !input.emailDeliveryAvailable) {
        return denied("email_delivery_unavailable");
    }

    const token = mintTeamInvitationToken();
    const record = await createTeamInvitationInTx(tx, {
        teamId: input.teamId,
        role: input.role,
        historyAccess,
        recipientEmailNormalized: input.recipientEmailNormalized,
        createdByAccountId: input.actorAccountId,
        tokenHash: digestTeamInvitationToken(token),
        now,
    });
    await saveRepeatKey(tx, dedupeKey, `${digest}:${record.id}`, defaultRepeatKeyExpiresAt(now));
    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return {
        ok: true,
        value: {
            invitation: projectTeamInvitationRowV1(record, now),
            token,
            teamName: authorized.value.team.name,
        },
    };
}

export type TeamInvitationPage = Readonly<{
    items: TeamInvitationRowV1[];
    nextCursor: string | null;
}>;

/**
 * The stored-timestamp predicate for one derived state.
 *
 * This is the same precedence `deriveTeamInvitationStateV1` applies, expressed as
 * the query the database can answer: acceptance outranks revocation, revocation
 * outranks expiry. Each branch therefore excludes the states above it, so a
 * revoked invitation that has also passed its expiry is still only `revoked` and
 * the filter can never disagree with the state its own row reports.
 *
 * Filtering in the database rather than after the page is what keeps the cursor
 * honest: a post-filter would return short pages and a `nextCursor` that skipped
 * rows the caller never saw.
 */
function invitationStateFilter(
    state: TeamInvitationStateV1,
    now: Date,
): Readonly<Record<string, unknown>> {
    switch (state) {
        case "accepted":
            return { acceptedAt: { not: null } };
        case "revoked":
            return { acceptedAt: null, revokedAt: { not: null } };
        case "expired":
            return { acceptedAt: null, revokedAt: null, expiresAt: { lte: now } };
        case "active":
            return activeTeamInvitationWhere(now);
    }
}

/**
 * Lists retained invitations newest first, including terminal rows: revoked and
 * accepted records are governance provenance and stay visible rather than vanishing.
 *
 * `state` narrows to one derived state; `null` returns every retained row.
 */
export async function listTeamInvitationsForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        cursor: string | null;
        limit: number;
        state?: TeamInvitationStateV1 | null;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamInvitationServiceResult<TeamInvitationPage, TeamInvitationAuthorityError>> {
    const authorized = await requireInvitationManagerInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
        ...input.authentication,
    });
    if (!authorized.ok) return authorized;

    const now = await readTransactionDatabaseTime(tx);
    const queryKey = teamInvitationsQueryKeyV1({ teamId: input.teamId, state: input.state ?? null });
    const cursor = input.cursor === null
        ? null
        : decodeTeamInvitationsCursorV1(input.cursor, queryKey);
    if (cursor !== null && cursor.status !== "ok") return denied("invalid_team_cursor");
    const cursorWhere = cursor === null ? {} : {
        OR: [
            { createdAt: { lt: new Date(cursor.cursor.createdAt) } },
            { createdAt: new Date(cursor.cursor.createdAt), id: { lt: cursor.cursor.id } },
        ],
    };
    const records = await tx.teamInvitation.findMany({
        where: {
            teamId: input.teamId,
            ...(input.state ? invitationStateFilter(input.state, now) : {}),
            ...cursorWhere,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
    });

    const page = records.slice(0, input.limit);
    return {
        ok: true,
        value: {
            items: page.map((record) => projectTeamInvitationRowV1(record, now)),
            nextCursor: records.length > input.limit && page[page.length - 1]
                ? encodeTeamInvitationsCursorV1({
                    queryKey,
                    createdAt: page[page.length - 1]!.createdAt.getTime(),
                    id: page[page.length - 1]!.id,
                })
                : null,
        },
    };
}

export async function revokeTeamInvitationForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        invitationId: string;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamInvitationServiceResult<TeamInvitationRowV1, TeamInvitationTargetError>> {
    const authorized = await requireInvitationManagerInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
        ...input.authentication,
    });
    if (!authorized.ok) return authorized;

    const now = await readTransactionDatabaseTime(tx);
    const revoked = await revokeTeamInvitationInTx(tx, {
        teamId: input.teamId,
        invitationId: input.invitationId,
        now,
    });

    // Revoke is same-state safe: an already terminal invitation returns its current
    // projection rather than an error, so a duplicated click is not a failure.
    const record = await tx.teamInvitation.findUnique({ where: { id: input.invitationId } });
    if (!record || record.teamId !== input.teamId) return denied("invitation_not_found");
    if (revoked === "revoked") await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return { ok: true, value: projectTeamInvitationRowV1(record, now) };
}

export type ReissueTeamInvitationResultValue = Readonly<{
    previous: TeamInvitationRowV1;
    replacement: TeamInvitationRowV1;
    /** `null` when this answer replays an already committed reissue; see create. */
    token: string | null;
    /**
     * The recipient the replacement actually carries, preserved or replaced. The
     * caller needs the normalized address to deliver to it; the wire projection
     * publishes only the mask.
     */
    recipientEmailNormalized: string | null;
    /** Read in the deciding transaction, for the mail boundary's subject line. */
    teamName: string;
}>;

export type ReissueTeamInvitationError =
    | TeamInvitationServiceError
    | "request_conflict"
    | "email_delivery_unavailable";

/**
 * Retry and Change email are the same operation: the old bearer stops working and a
 * fresh seven-day invitation carries the same role and history intent.
 *
 * They differ only in the recipient. `replacementRecipientEmailNormalized === null`
 * is Retry — the same offer to the same person — so the stored constraint is
 * preserved. Dropping it there would silently convert an invitation meant for one
 * mailbox into one anybody signed into this Home could accept, which is a widening
 * no Retry button asks for. A supplied address is Change email and replaces it.
 * There is deliberately no way to convert an email-bound invitation into a
 * transferable one: that widening would need its own explicit intent.
 */
export async function reissueTeamInvitationForActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        actorAccountId: string;
        invitationId: string;
        replacementRecipientEmailNormalized: string | null;
        /** The caller's retry identity, so a lost response cannot retire two bearers. */
        requestKey: string;
        /**
         * Whether this Home could deliver mail right now, decided by the mail owner
         * before the transaction. A reissue that would carry a recipient it cannot
         * reach is refused instead of retiring a working bearer for an undeliverable
         * replacement.
         */
        emailDeliveryAvailable: boolean;
        authentication?: TeamOperationAuthenticationContext;
    }>,
): Promise<TeamInvitationServiceResult<ReissueTeamInvitationResultValue, ReissueTeamInvitationError>> {
    const authorized = await requireInvitationManagerInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
        ...input.authentication,
    });
    if (!authorized.ok) return authorized;

    const existing = await tx.teamInvitation.findUnique({ where: { id: input.invitationId } });
    if (!existing || existing.teamId !== input.teamId) return denied("invitation_not_found");

    const now = await readTransactionDatabaseTime(tx);
    const recipientEmailNormalized = input.replacementRecipientEmailNormalized
        ?? existing.recipientEmailNormalized;

    const dedupeKey = invitationReissueRequestKey(input);
    const digest = invitationPayloadDigest([recipientEmailNormalized]);
    const recorded = await replayRecordedInvitationInTx(tx, { dedupeKey, digest, now });
    if (recorded.status === "conflict") return denied("request_conflict");
    if (recorded.status === "replayed") {
        return {
            ok: true,
            value: {
                previous: projectTeamInvitationRowV1(existing, now),
                replacement: projectTeamInvitationRowV1(recorded.record, now),
                token: null,
                recipientEmailNormalized: recorded.record.recipientEmailNormalized,
                teamName: authorized.value.team.name,
            },
        };
    }

    // Mail readiness is a precondition for minting a *new* email-bound bearer,
    // not for resolving an already committed retry identity. Rechecking this
    // before the replay lookup would turn response loss plus a later mail outage
    // into a false failure even though the replacement already exists. Exact
    // replay returns only safe metadata and never attempts delivery again.
    if (recipientEmailNormalized !== null && !input.emailDeliveryAvailable) {
        return denied("email_delivery_unavailable");
    }

    const token = mintTeamInvitationToken();
    const outcome = await reissueTeamInvitationInTx(tx, {
        teamId: input.teamId,
        invitationId: input.invitationId,
        recipientEmailNormalized,
        createdByAccountId: input.actorAccountId,
        tokenHash: digestTeamInvitationToken(token),
        now,
    });
    if (outcome === "unchanged") return denied("invitation_not_active");

    await saveRepeatKey(tx, dedupeKey, `${digest}:${outcome.replacement.id}`, defaultRepeatKeyExpiresAt(now));
    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    return {
        ok: true,
        value: {
            previous: projectTeamInvitationRowV1(outcome.previous, now),
            replacement: projectTeamInvitationRowV1(outcome.replacement, now),
            token,
            recipientEmailNormalized,
            teamName: authorized.value.team.name,
        },
    };
}

/**
 * The Home identity shown on a join screen.
 *
 * It is supplied by the Homes/auth effective projection rather than derived here: the
 * application origin is a renderer and the inviter is not the Home owner, so neither
 * may stand in for Home identity or storage disclosure.
 */
export type JoinScreenHomeIdentity = Readonly<{
    serverId: string;
    /** `null` until this Home publishes a name of its own; never a borrowed one. */
    displayName: string | null;
    /** `null` until the Homes storage/method policy projection publishes one. */
    storageMode: "plain" | "encrypted" | null;
    /** `null` until this runtime publishes a purpose of its own; never inferred. */
    hosting: "personal" | "shared" | null;
}>;

export type TeamInvitationAuthEntryContext = Readonly<{
    team: Readonly<{
        teamId: string;
        name: string;
        logo: TeamInvitationPreviewV1["team"]["logo"];
    }>;
    /** Lane 03 auth entry interprets this only through its canonical policy codec. */
    authenticationPolicy: unknown;
    recipientEmailNormalized: string | null;
}>;

type ActiveTeamInvitationContext = Readonly<{
    record: TeamInvitationRecord;
    now: Date;
    team: Readonly<{
        id: string;
        name: string;
        logo: unknown;
        authenticationPolicy: unknown;
    }>;
}>;

export type TeamInvitationApprovalPreparation = Readonly<{
    invitationId: string;
    teamId: string;
    tokenHash: string;
    expiresAt: Date;
    preview: TeamInvitationPreviewV1;
}>;

function projectTeamInvitationAuthEntryContext(
    record: TeamInvitationRecord,
    team: ActiveTeamInvitationContext['team'],
): TeamInvitationAuthEntryContext {
    return {
        team: {
            teamId: team.id,
            name: team.name,
            logo: projectTeamLogoRefV1(team),
        },
        authenticationPolicy: team.authenticationPolicy,
        recipientEmailNormalized: record.recipientEmailNormalized,
    };
}

async function readActiveTeamInvitationContextInTx(
    tx: Tx,
    token: unknown,
): Promise<ActiveTeamInvitationContext | null> {
    if (!await isTeamMembershipAdmissionEnabled({ tx })) return null;
    const tokenHash = tryDigestTeamInvitationToken(token);
    if (tokenHash === null) return null;

    const record = await readTeamInvitationByTokenHashInTx(tx, tokenHash);
    if (record === null) return null;

    const now = await readTransactionDatabaseTime(tx);
    const state = deriveTeamInvitationStateV1({
        acceptedAt: record.acceptedAt?.getTime() ?? null,
        revokedAt: record.revokedAt?.getTime() ?? null,
        expiresAt: record.expiresAt.getTime(),
    }, now.getTime());
    if (state !== "active") return null;

    const team = await tx.team.findUnique({
        where: { id: record.teamId },
        select: { id: true, name: true, logo: true, authenticationPolicy: true, archivedAt: true },
    });
    if (!team || team.archivedAt !== null) return null;
    return { record, now, team };
}

/**
 * The invitation owner's narrow auth-entry projection. It shares the same active-
 * bearer decision as preview and exposes neither invitation intent nor the bearer.
 */
export async function resolveTeamInvitationAuthEntryContextInTx(
    tx: Tx,
    input: Readonly<{ token: unknown }>,
): Promise<TeamInvitationAuthEntryContext | null> {
    const context = await readActiveTeamInvitationContextInTx(tx, input.token);
    if (context === null) return null;
    return projectTeamInvitationAuthEntryContext(context.record, context.team);
}

/**
 * Resolves the same bounded auth-entry context from a server-held verification
 * operation's exact invitation reference. The reference never crosses the
 * public boundary; current invitation and Team state are re-read here.
 */
export async function resolveTeamInvitationAuthEntryReferenceContextInTx(
    tx: Tx,
    input: Readonly<{ invitationId: string; tokenHash: string; teamId: string }>,
): Promise<TeamInvitationAuthEntryContext | null> {
    const record = await readActiveTeamInvitationAdmissionReferenceInTx(tx, input);
    if (!record) return null;
    const team = await tx.team.findUnique({
        where: { id: record.teamId },
        select: { id: true, name: true, logo: true, authenticationPolicy: true, archivedAt: true },
    });
    if (!team || team.archivedAt !== null) return null;
    return projectTeamInvitationAuthEntryContext(record, team);
}

/**
 * The bounded, read-only preview.
 *
 * It never consumes, never mutates, and never widens: no roster, no provider bindings,
 * no actor identifier, no digest. The inviter appears only as the short display label
 * the invitation email already shows the same person. Unknown and terminal invitations
 * collapse to one `unavailable` outcome so an unauthenticated caller cannot enumerate
 * which bearers exist or learn why a specific one failed.
 */
export async function previewTeamInvitationByTokenInTx(
    tx: Tx,
    input: Readonly<{ token: unknown; home: JoinScreenHomeIdentity }>,
): Promise<TeamInvitationPreviewResultV1> {
    const prepared = await resolveTeamInvitationApprovalPreparationInTx(tx, input);
    return prepared === null
        ? { outcome: "unavailable" }
        : { outcome: "ok", preview: prepared.preview };
}

/**
 * Resolve the exact active invitation once for both public preview and authenticated
 * deferred-approval preparation. The latter persists only this digest/reference
 * projection; the bearer itself never leaves the request boundary.
 */
export async function resolveTeamInvitationApprovalPreparationInTx(
    tx: Tx,
    input: Readonly<{ token: unknown; home: JoinScreenHomeIdentity }>,
): Promise<TeamInvitationApprovalPreparation | null> {
    const context = await readActiveTeamInvitationContextInTx(tx, input.token);
    if (context === null) return null;
    const { record, team } = context;
    return {
        invitationId: record.id,
        teamId: team.id,
        tokenHash: Buffer.from(record.tokenHash).toString("hex"),
        expiresAt: record.expiresAt,
        preview: await projectTeamInvitationPreviewInTx(tx, context, input.home),
    };
}

/** Held references share the public preview projection and active-offer checks. */
export async function previewTeamInvitationByReferenceInTx(
    tx: Tx,
    input: Readonly<{ invitationId: string; tokenHash: string; teamId: string; home: JoinScreenHomeIdentity }>,
): Promise<TeamInvitationPreviewV1 | null> {
    if (!await isTeamMembershipAdmissionEnabled({ tx })) return null;
    const record = await readActiveTeamInvitationAdmissionReferenceInTx(tx, input);
    if (!record) return null;
    const team = await tx.team.findUnique({
        where: { id: record.teamId },
        select: { id: true, name: true, logo: true, authenticationPolicy: true, archivedAt: true },
    });
    if (!team || team.archivedAt !== null) return null;
    return projectTeamInvitationPreviewInTx(tx, {
        record, team, now: await readTransactionDatabaseTime(tx),
    }, input.home);
}

async function projectTeamInvitationPreviewInTx(
    tx: Tx,
    { record, now, team }: ActiveTeamInvitationContext,
    home: JoinScreenHomeIdentity,
): Promise<TeamInvitationPreviewV1> {
    const projected = projectTeamInvitationRowV1(record, now);
    const inviterLabel = await readTeamInvitationInviterLabelInTx(tx, record.createdByAccountId);
    return {
        home,
        team: {
            teamId: team.id,
            name: team.name,
            logo: projectTeamLogoRefV1(team),
            // Accent is derived from the opaque Team id, never persisted, so a
            // rename cannot change a Team's colour.
            accentSeed: team.id,
        },
        role: projected.role,
        historyAccess: projected.historyAccess,
        state: "active",
        expiresAt: projected.expiresAt,
        recipientEmailMask: maskTeamInvitationRecipientEmail(record.recipientEmailNormalized),
        inviterLabel,
    };
}

/**
 * The inviter as the join screen may state them: one short display label from the
 * canonical Account label owner, exactly what the invitation email already sends the
 * same person. The Account id stays inside this transaction, and an inviter whose
 * Account was removed — or who carries no name of their own — resolves to `null`
 * rather than to a placeholder the Home cannot substantiate.
 */
async function readTeamInvitationInviterLabelInTx(
    tx: Tx,
    inviterAccountId: string | null,
): Promise<string | null> {
    if (inviterAccountId === null) return null;
    const inviter = await tx.account.findUnique({
        where: { id: inviterAccountId },
        select: { firstName: true, lastName: true, username: true },
    });
    return inviter ? resolveAccountDisplayLabelV1(inviter) : null;
}
