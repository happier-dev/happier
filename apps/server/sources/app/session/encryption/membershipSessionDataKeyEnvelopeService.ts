import type { Prisma } from "@prisma/client";
import { decodeBase64, encodeBase64 } from "privacy-kit";
import { decodeMembershipSessionDataKeyEnvelopeCursorV1, encodeMembershipSessionDataKeyEnvelopeCursorV1, MembershipSessionDataKeyEnvelopeErrorCodeV1Schema, MembershipSessionDataKeyEnvelopeErrorV1Schema, PatchMembershipSessionDataKeyEnvelopesV1Schema, type MembershipSessionDataKeyEnvelopeExceptionsV1, type MembershipSessionDataKeyEnvelopeItemV1, type MembershipSessionDataKeyEnvelopeErrorCodeV1, type MembershipSessionDataKeyEnvelopePageQueryV1, type MembershipSessionDataKeyEnvelopePageV1 } from '@happier-dev/protocol/sessions/encryption/membershipSessionDataKeyEnvelopes';
import {
    teamErrorHttpStatusV1,
    type TeamErrorCodeV1,
} from "@happier-dev/protocol/teams";

import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { buildMembershipHistorySessionAccessWhereInTx } from "@/app/session/access/sessionAccessWhere";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { getTeamGroupForActorInTx } from "@/app/teams/groups/groupService";
import { getTeamMemberForActorInTx } from "@/app/teams/memberships/memberAdministration";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";

import {
    isStructurallyValidSessionDataKeyEnvelope,
    writeSessionDataKeyEnvelopeInTx,
} from "./sessionDataKeyEnvelopePersistence";
import {
    projectRecipientContentKey,
    RECIPIENT_READINESS_SELECT,
} from "./sessionDataKeyRecipientProjection";

/**
 * The Team/Group membership-history view of the same recipient data-key envelopes.
 *
 * It is one service for both nested routes: a Team membership and a Group
 * membership are two addresses for one subject — "which Sessions this person
 * could already read but cannot yet decrypt" — so the Team and Group transports
 * are context adapters, not two key stores.
 *
 * Every decision it needs already has an owner. Whether the caller may address
 * the membership at all is the Team member/Group read owner's answer; which
 * Sessions the target may read and the caller may disclose is Lane 04's
 * same-transaction predicate; recipient readiness is the Account encryption
 * owner's; envelope structure is the Protocol codec's; the row and its
 * recipient-private invalidation belong to the persistence owner. This module
 * composes them and owns only the page shape and the crypto-eligibility filter.
 *
 * It never opens an envelope, never treats a stored tuple as access, and never
 * discloses the identity of a Session the caller cannot already read.
 */

/**
 * How many authorized Sessions one round trip binds while the walk builds the
 * page and its exception aggregate.
 *
 * It matches the Account-filter chunking the per-Session collection already
 * uses, staying below SQLite's conservative bind-parameter boundary. It bounds
 * memory and transport per round trip, not the authorized result set, and it is
 * deliberately independent of the wire page bound.
 */
const SESSION_SCAN_CHUNK = 100;

/**
 * The subject of one history operation, exactly as Lane 01 addresses it.
 *
 * A Team membership has its own immutable id. A Group membership is addressed
 * by `{ teamId, groupId, accountId }` because Lane 01 keys it by the current
 * Team-membership lifetime; inventing a Group-membership surrogate here would
 * create a second identity for something that already has one.
 */
export type MembershipSessionDataKeyEnvelopeSubject =
    | Readonly<{ kind: "team"; teamId: string; teamMembershipId: string }>
    | Readonly<{ kind: "group"; teamId: string; groupId: string; accountId: string }>;

/**
 * Two vocabularies meet at this nested resource and each keeps its own owner.
 *
 * Addressing the membership is a Team question and answers in the Team error
 * contract; the envelope payload is the data-key resource's and answers in its
 * contract. Collapsing them into a third enum would make the same domain result
 * read differently depending on which resource produced it.
 */
export type MembershipSessionDataKeyEnvelopeError =
    | TeamErrorCodeV1
    | MembershipSessionDataKeyEnvelopeErrorCodeV1;

/**
 * Data-key errors reachable from the membership-history service.
 *
 * The per-Session collection has additional answers (for example
 * `session_not_found` and `data_key_not_required`) that this nested resource
 * cannot produce. Keeping those codes out of the route schema makes the wire
 * contract match the service's typed result instead of advertising another
 * resource's failure modes.
 */
export { MembershipSessionDataKeyEnvelopeErrorCodeV1Schema, MembershipSessionDataKeyEnvelopeErrorV1Schema };

/**
 * The five statuses both nested routes publish. They are spread into each
 * route's response map rather than shared as one object: a shared object breaks
 * the Zod type provider's inference, which silently degrades `request.body` to
 * `unknown` and takes the strict input contract with it.
 */
export const MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_ERROR_RESPONSES = {
    400: MembershipSessionDataKeyEnvelopeErrorV1Schema,
    403: MembershipSessionDataKeyEnvelopeErrorV1Schema,
    404: MembershipSessionDataKeyEnvelopeErrorV1Schema,
    409: MembershipSessionDataKeyEnvelopeErrorV1Schema,
    503: MembershipSessionDataKeyEnvelopeErrorV1Schema,
} as const;

export type MembershipSessionDataKeyEnvelopePageResult =
    | Readonly<{ ok: true; page: MembershipSessionDataKeyEnvelopePageV1 }>
    | Readonly<{ ok: false; error: MembershipSessionDataKeyEnvelopeError }>;

export type MembershipSessionDataKeyEnvelopePatchResult =
    | Readonly<{ ok: true; appliedCount: number }>
    | Readonly<{ ok: false; error: MembershipSessionDataKeyEnvelopeError }>;

/** One code decides one status; there are no per-entry errors or retry hints. */
export function membershipSessionDataKeyEnvelopeHttpStatus(
    error: MembershipSessionDataKeyEnvelopeError,
): 400 | 403 | 404 | 409 | 503 {
    switch (error) {
        case "invalid_request":
        case "invalid_cursor":
            return 400;
        case "forbidden":
            return 403;
        case "recipient_changed":
        case "recipient_key_unavailable":
        case "session_data_key_unavailable":
            return 409;
        default:
            return teamErrorHttpStatusV1(error);
    }
}

type SubjectResolution =
    | Readonly<{ ok: true; recipientAccountId: string; where: Prisma.SessionWhereInput }>
    | Readonly<{ ok: false; error: MembershipSessionDataKeyEnvelopeError }>;

/**
 * Resolves the discovery target and the authorized Session predicate together.
 *
 * The caller's authority over the *membership* is asked first and separately:
 * Lane 04's predicate expresses caller authority per Session, so a stranger to
 * the Team would otherwise reach an empty-but-well-formed page that confirms
 * the membership exists and publishes the target's binding. The Team member and
 * Group read owners already conceal exactly that, so this asks them.
 *
 * The Team path resolves the current Account through that same owner before
 * handing it to Lane 04 as `expectedAccountId`: a provider reset can preserve a
 * `teamMembershipId` while replacing its Account, and the resolved Account —
 * never the membership id — is the recipient identity everything else echoes.
 */
async function resolveSubjectInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    subject: MembershipSessionDataKeyEnvelopeSubject;
    authentication: SessionAccessAuthentication;
}>): Promise<SubjectResolution> {
    const { actorAccountId, subject } = input;
    // The verified request credential the route already holds. Without it the Team
    // visibility owners qualify this caller as an evidence-free present user, so a
    // restricted Team answers `team_authentication_required` to the very manager who
    // just qualified for this request. Mapped once, in the shape the Team
    // qualification owner takes everywhere else.
    const teamAuthentication = {
        env: input.authentication.env,
        authenticationAuthority: input.authentication.authority,
        ...(input.authentication.authenticationEvidence === undefined
            ? {}
            : { authenticationEvidence: input.authentication.authenticationEvidence }),
    } as const;
    if (subject.kind === "team") {
        const member = await getTeamMemberForActorInTx(tx, {
            teamId: subject.teamId,
            actorAccountId,
            membershipId: subject.teamMembershipId,
            authentication: teamAuthentication,
        });
        if (!member.ok) return { ok: false, error: member.error };

        const access = await buildMembershipHistorySessionAccessWhereInTx(tx, {
            actorAccountId,
            authentication: input.authentication,
            subject: {
                kind: "team",
                teamId: subject.teamId,
                teamMembershipId: subject.teamMembershipId,
                expectedAccountId: member.value.accountId,
            },
        });
        // Lane 04 conceals a non-current, guest or ineligible membership behind
        // one answer; this resource must not turn that into a probe.
        if (!access.ok) return { ok: false, error: "membership_not_found" };
        return { ok: true, recipientAccountId: access.recipientAccountId, where: access.where };
    }

    const group = await getTeamGroupForActorInTx(tx, {
        teamId: subject.teamId,
        actorAccountId,
        groupId: subject.groupId,
        authentication: teamAuthentication,
    });
    if (!group.ok) return { ok: false, error: group.error };

    const access = await buildMembershipHistorySessionAccessWhereInTx(tx, {
        actorAccountId,
        authentication: input.authentication,
        subject: {
            kind: "group",
            teamId: subject.teamId,
            groupId: subject.groupId,
            accountId: subject.accountId,
        },
    });
    if (!access.ok) return { ok: false, error: "membership_not_found" };
    return { ok: true, recipientAccountId: access.recipientAccountId, where: access.where };
}

/**
 * The authorized predicate AND the only crypto fact a database can decide.
 *
 * Structural envelope validity is the Protocol codec's answer and is applied to
 * the rows this predicate already admitted, never as a filter that could let an
 * unauthorized Session in. Composition is by `AND` so no later clause can widen
 * what Lane 04 authorized.
 */
function eligibleSessionWhere(
    authorized: Prisma.SessionWhereInput,
    afterSessionId: string | null,
): Prisma.SessionWhereInput {
    return {
        AND: [
            authorized,
            // A plain Session needs no envelope and is never history work.
            { encryptionMode: "e2ee" },
            ...(afterSessionId === null ? [] : [{ id: { gt: afterSessionId } }]),
        ],
    };
}

type ScannedSession = Readonly<{
    id: string;
    accountId: string;
    caller: Uint8Array | null;
    target: Uint8Array | null;
}>;

async function readSessionChunk(tx: Tx, input: Readonly<{
    where: Prisma.SessionWhereInput;
    actorAccountId: string;
    recipientAccountId: string;
    afterSessionId: string | null;
}>): Promise<readonly ScannedSession[]> {
    const sessions = await tx.session.findMany({
        where: eligibleSessionWhere(input.where, input.afterSessionId),
        select: { id: true, accountId: true },
        orderBy: { id: "asc" },
        take: SESSION_SCAN_CHUNK,
    });
    if (sessions.length === 0) return [];

    const sessionIds = sessions.map(session => session.id);
    const envelopes = await tx.sessionDataKeyEnvelope.findMany({
        where: {
            sessionId: { in: sessionIds },
            recipientAccountId: { in: [input.actorAccountId, input.recipientAccountId] },
        },
        select: { sessionId: true, recipientAccountId: true, encryptedDataKey: true },
    });
    const stored = new Map<string, Uint8Array>();
    for (const row of envelopes) {
        stored.set(`${row.sessionId}\u0000${row.recipientAccountId}`, new Uint8Array(row.encryptedDataKey));
    }
    return sessions.map(session => ({
        id: session.id,
        accountId: session.accountId,
        caller: stored.get(`${session.id}\u0000${input.actorAccountId}`) ?? null,
        target: stored.get(`${session.id}\u0000${input.recipientAccountId}`) ?? null,
    }));
}

/**
 * Absence and structural validity are different facts, and only the second one is
 * this resource's to decide — so the persistence owner's exported predicate
 * decides it here too, for every envelope this service classifies.
 */
function isStructurallyValid(envelope: Uint8Array | null): boolean {
    return envelope !== null && isStructurallyValidSessionDataKeyEnvelope(envelope);
}

/**
 * Exception-bucket rule, shared by the set-oriented aggregate below.
 *
 * A caller-owned Session with no envelope at all has no published transferable
 * data key — the Home cannot know which algorithm secured it and must not guess
 * — while every other unusable caller envelope is ordinary repair work on the
 * caller's own tuple. The two buckets do not overlap by construction, and neither
 * is retried as work.
 */

/**
 * One bounded page of actionable history work plus a cursorless exception aggregate.
 *
 * The recipient's readiness is settled before any Session is read: an
 * unavailable recipient is a whole-page state with no per-Session work to show,
 * and reading eligible Sessions first would spend the scan to reach the same
 * answer.
 *
 * Paging is DB-backed: the actionable walk begins strictly after the decoded
 * keyset cursor in the database predicate, never at the corpus origin with a
 * prefix discarded in application code. On cursorless discovery and final
 * recheck, the exception aggregate is a separate set-oriented count over the
 * same authorized eligibility owner (missing-caller buckets via indexed
 * `COUNT`, present-but-invalid via one filtered envelope fetch and the Protocol
 * codec). Continuations return `null` instead of repeatedly reading that global
 * corpus; the invoking client retains the last authoritative non-null counts.
 */
export async function readMembershipSessionDataKeyEnvelopePage(input: Readonly<{
    actorAccountId: string;
    subject: MembershipSessionDataKeyEnvelopeSubject;
    query: MembershipSessionDataKeyEnvelopePageQueryV1;
    authentication: SessionAccessAuthentication;
}>): Promise<MembershipSessionDataKeyEnvelopePageResult> {
    const cursorSessionId = input.query.cursor === undefined
        ? null
        : decodeMembershipSessionDataKeyEnvelopeCursorV1(input.query.cursor);
    if (input.query.cursor !== undefined && cursorSessionId === null) {
        return { ok: false, error: "invalid_cursor" };
    }

    return await inReadSnapshot(async tx => {
        const subject = await resolveSubjectInTx(tx, input);
        if (!subject.ok) return { ok: false, error: subject.error };

        const recipient = await tx.account.findUnique({
            where: { id: subject.recipientAccountId },
            select: RECIPIENT_READINESS_SELECT,
        });
        if (!recipient) return { ok: false, error: "account_not_found" };
        const contentKey = projectRecipientContentKey(
            recipient,
            deriveAccountRecipientEnvelopeReadinessFromRow(recipient),
        );
        if (contentKey.status !== "available") {
            return { ok: true, page: {
                status: "recipient_unavailable",
                recipientAccountId: subject.recipientAccountId,
                contentKey,
            } };
        }

        const items: MembershipSessionDataKeyEnvelopeItemV1[] = [];
        let nextCursor: string | null = null;
        // DB-backed keyset paging: the actionable walk starts strictly after the
        // decoded cursor in the database predicate. No prefix is read and discarded
        // in application code on continuation pages.
        let afterSessionId: string | null = cursorSessionId;

        for (;;) {
            const chunk = await readSessionChunk(tx, {
                where: subject.where,
                actorAccountId: input.actorAccountId,
                recipientAccountId: subject.recipientAccountId,
                afterSessionId,
            });
            if (chunk.length === 0) break;

            for (const session of chunk) {
                // Only structurally usable caller envelopes with a missing/invalid
                // target tuple are actionable work. Caller exceptions are counted
                // by the separate set-oriented aggregate below, not here.
                if (!isStructurallyValid(session.caller)) continue;
                if (isStructurallyValid(session.target)) continue;

                if (items.length < input.query.limit) {
                    // The caller's own current envelope travels with the item so
                    // a cold client never needs one Session-detail request each.
                    items.push({ sessionId: session.id, callerDataKeyEnvelope: encodeBase64(new Uint8Array(session.caller!)) });
                } else {
                    // One further actionable Session exists beyond this page, so
                    // the cursor is the last item actually delivered. The items
                    // walk stops here; the exception aggregate is separate and
                    // does not require scanning the remainder for paging.
                    nextCursor = encodeMembershipSessionDataKeyEnvelopeCursorV1(items[items.length - 1]!.sessionId);
                    break;
                }
            }
            if (nextCursor !== null) break;

            afterSessionId = chunk[chunk.length - 1]!.id;
            if (chunk.length < SESSION_SCAN_CHUNK) break;
        }

        // Each item carries its Session's stored shared metadata and layout, so the client can
        // prove the key it is about to reseal is this Session's (`readSessionKeyBoundSharedMetadataV1`).
        // One read for the delivered page only; scanned rows that are not work never load it.
        if (items.length > 0) {
            const metadataRows = await tx.session.findMany({
                where: { id: { in: items.map(item => item.sessionId) } },
                select: { id: true, metadata: true, metadataLayoutVersion: true },
            });
            const metadataById = new Map(metadataRows.map(row => [row.id, row]));
            for (const [index, item] of items.entries()) {
                const row = metadataById.get(item.sessionId);
                if (row) items[index] = { ...item, metadata: row.metadata, metadataLayoutVersion: row.metadataLayoutVersion };
            }
        }

        // Separate set-oriented exception aggregate over the whole authorized
        // eligible set. Missing-caller buckets are indexed COUNTs; present-but-
        // invalid caller envelopes are one filtered envelope fetch checked with
        // the Protocol codec. No Session identity leaks: only two counts leave
        // this boundary, and the buckets do not overlap by construction.
        let exceptions: MembershipSessionDataKeyEnvelopeExceptionsV1 | null = null;
        if (cursorSessionId === null) {
            const e2eeAuthorized: Prisma.SessionWhereInput = {
                AND: [subject.where, { encryptionMode: "e2ee" }],
            };
            const targetEnvelopeMissing: Prisma.SessionWhereInput = {
                dataKeyEnvelopes: { none: { recipientAccountId: subject.recipientAccountId } },
            };
            const [callerMissingOwned, callerMissingUnowned] = await Promise.all([
                tx.session.count({
                    where: {
                        AND: [
                            e2eeAuthorized,
                            targetEnvelopeMissing,
                            { accountId: input.actorAccountId },
                            { dataKeyEnvelopes: { none: { recipientAccountId: input.actorAccountId } } },
                        ],
                    },
                }),
                tx.session.count({
                    where: {
                        AND: [
                            e2eeAuthorized,
                            targetEnvelopeMissing,
                            { accountId: { not: input.actorAccountId } },
                            { dataKeyEnvelopes: { none: { recipientAccountId: input.actorAccountId } } },
                        ],
                    },
                }),
            ]);
            const presentCallerEnvelopes = await tx.sessionDataKeyEnvelope.findMany({
                where: {
                    recipientAccountId: input.actorAccountId,
                    session: { AND: [e2eeAuthorized, targetEnvelopeMissing] },
                },
                select: { encryptedDataKey: true },
            });
            let callerInvalidPresent = 0;
            for (const row of presentCallerEnvelopes) {
                if (!isStructurallyValid(new Uint8Array(row.encryptedDataKey))) {
                    callerInvalidPresent += 1;
                }
            }

            // A structurally invalid target tuple is still unfinished work. It
            // cannot participate in the indexed `none` predicates above because
            // the row exists, so classify only those invalid target rows here.
            // Valid target tuples are deliberately ignored: once the recipient
            // can open the Session, a problem with this particular caller's
            // tuple is no longer a target-preparation exception.
            let invalidTargetCallerMissingOwned = 0;
            let invalidTargetCallerMissingUnowned = 0;
            let invalidTargetCallerInvalid = 0;
            const presentTargetEnvelopes = await tx.sessionDataKeyEnvelope.findMany({
                where: {
                    recipientAccountId: subject.recipientAccountId,
                    session: e2eeAuthorized,
                },
                select: {
                    sessionId: true,
                    encryptedDataKey: true,
                    session: { select: { accountId: true } },
                },
            });
            const invalidTargets = presentTargetEnvelopes.filter(row => (
                !isStructurallyValid(new Uint8Array(row.encryptedDataKey))
            ));
            if (invalidTargets.length > 0) {
                const invalidTargetSessionIds = invalidTargets.map(row => row.sessionId);
                const callerRows = await tx.sessionDataKeyEnvelope.findMany({
                    where: {
                        sessionId: { in: invalidTargetSessionIds },
                        recipientAccountId: input.actorAccountId,
                    },
                    select: { sessionId: true, encryptedDataKey: true },
                });
                const callers = new Map(callerRows.map(row => [
                    row.sessionId,
                    new Uint8Array(row.encryptedDataKey),
                ]));
                for (const target of invalidTargets) {
                    const caller = callers.get(target.sessionId) ?? null;
                    if (caller === null) {
                        if (target.session.accountId === input.actorAccountId) {
                            invalidTargetCallerMissingOwned += 1;
                        } else {
                            invalidTargetCallerMissingUnowned += 1;
                        }
                    } else if (!isStructurallyValid(caller)) {
                        invalidTargetCallerInvalid += 1;
                    }
                }
            }
            exceptions = {
                callerVisibleNonTransferableSessionCount:
                    callerMissingOwned + invalidTargetCallerMissingOwned,
                callerEnvelopeRepairRequiredCount:
                    callerMissingUnowned
                    + callerInvalidPresent
                    + invalidTargetCallerMissingUnowned
                    + invalidTargetCallerInvalid,
            };
        }

        return { ok: true, page: {
            status: "ready",
            recipientAccountId: subject.recipientAccountId,
            contentKey,
            items,
            exceptions,
            nextCursor,
        } };
    });
}

type ValidatedEntry = Readonly<{ sessionId: string; envelope: Uint8Array }>;

/**
 * Parses the whole bounded request before the transaction opens.
 *
 * Boundedness, duplicate Session ids and the exact envelope byte contract are
 * all decided here, so a malformed page can never reach a partial write.
 */
function validateRequest(request: unknown): Readonly<{
    recipientAccountId: string;
    entries: readonly ValidatedEntry[];
}> | null {
    const parsed = PatchMembershipSessionDataKeyEnvelopesV1Schema.safeParse(request);
    if (!parsed.success) return null;

    const entries: ValidatedEntry[] = [];
    const seenSessionIds = new Set<string>();
    for (const entry of parsed.data.entries) {
        if (seenSessionIds.has(entry.sessionId)) return null;
        seenSessionIds.add(entry.sessionId);
        let envelope: Uint8Array;
        try {
            envelope = decodeBase64(entry.encryptedDataKey);
        } catch {
            return null;
        }
        if (!isStructurallyValid(envelope)) return null;
        entries.push({ sessionId: entry.sessionId, envelope });
    }
    return { recipientAccountId: parsed.data.recipientAccountId, entries };
}

/**
 * Commits one bounded page of historical envelopes atomically.
 *
 * Every recheck runs before the first write, so one lost membership, one
 * withdrawn Session or one malformed entry leaves the collection exactly as it
 * was rather than half prepared. A structurally valid current tuple may be
 * overwritten: `Prepare again` produces legitimately different ciphertext for
 * the same data key, and last-write-wins is what makes repair work without a
 * revision, digest or receipt.
 */
export async function applyMembershipSessionDataKeyEnvelopes(input: Readonly<{
    actorAccountId: string;
    subject: MembershipSessionDataKeyEnvelopeSubject;
    request: unknown;
    authentication: SessionAccessAuthentication;
}>): Promise<MembershipSessionDataKeyEnvelopePatchResult> {
    const validated = validateRequest(input.request);
    if (validated === null) return { ok: false, error: "invalid_request" };

    return await inTx(async tx => {
        const discoveredSubject = await resolveSubjectInTx(tx, input);
        if (!discoveredSubject.ok) return { ok: false, error: discoveredSubject.error };
        const sessionIds = validated.entries.map(entry => entry.sessionId);
        // Native membership changes fence affected Sessions before destroying
        // their old entitlement. Key/lifecycle changes oppose Account admission.
        // Admit every requested Session and both explicit Accounts together,
        // then re-resolve the subject rather than using a discovery-time policy.
        await acquireSessionAccountCursorLocksInTx(tx, sessionIds, [input.actorAccountId, discoveredSubject.recipientAccountId]);
        const subject = await resolveSubjectInTx(tx, input);
        if (!subject.ok) return { ok: false, error: subject.error };

        // Membership identity is not enough. A provider reset preserves the
        // `teamMembershipId` while replacing its Account, and ciphertext sealed
        // to the previous Account must never land in the replacement's tuple.
        if (validated.recipientAccountId !== subject.recipientAccountId) {
            return { ok: false, error: "recipient_changed" };
        }

        const recipient = await tx.account.findUnique({
            where: { id: subject.recipientAccountId },
            select: RECIPIENT_READINESS_SELECT,
        });
        if (!recipient) return { ok: false, error: "recipient_changed" };
        if (deriveAccountRecipientEnvelopeReadinessFromRow(recipient).status !== "available") {
            return { ok: false, error: "recipient_key_unavailable" };
        }

        const authorized = await tx.session.findMany({
            where: { AND: [eligibleSessionWhere(subject.where, null), { id: { in: sessionIds } }] },
            select: { id: true },
        });
        // Access loss and a Session that was never eligible are one answer: the
        // caller may not disclose this Session's key now, whichever it is.
        if (authorized.length !== sessionIds.length) return { ok: false, error: "forbidden" };

        const callerEnvelopes = await tx.sessionDataKeyEnvelope.findMany({
            where: { sessionId: { in: sessionIds }, recipientAccountId: input.actorAccountId },
            select: { sessionId: true, encryptedDataKey: true },
        });
        const callerBySessionId = new Map(
            callerEnvelopes.map(row => [row.sessionId, new Uint8Array(row.encryptedDataKey)] as const),
        );
        for (const sessionId of sessionIds) {
            // Only the invoking client can prove its envelope opens to the
            // Session's standalone key; an Account-scoped fallback is never
            // transferable, so a missing or unparseable caller tuple stops here.
            if (!isStructurallyValid(callerBySessionId.get(sessionId) ?? null)) {
                return { ok: false, error: "session_data_key_unavailable" };
            }
        }

        for (const entry of validated.entries) {
            const written = await writeSessionDataKeyEnvelopeInTx(tx, {
                sessionId: entry.sessionId,
                recipientAccountId: subject.recipientAccountId,
                encryptedDataKey: entry.envelope,
                markRecipientChanged: true,
            });
            if (!written.ok) return { ok: false, error: "invalid_request" };
        }

        return { ok: true, appliedCount: validated.entries.length };
    }, { isolationLevel: "ReadCommitted" });
}
