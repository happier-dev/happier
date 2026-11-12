import { resolveStructuralSessionAccessForAccountsInTx } from "./sessionAccess";
import { isDeepStrictEqual } from "node:util";
import { decodeBase64 } from "privacy-kit";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "./sessionRecipients";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { admitDirectSessionRecipientEnvelope, type DirectSessionRecipientEnvelopeError } from "@/app/session/encryption/sessionDataKeyEnvelopeAdmission";
import { inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { ShareAccessLevel, TeamMembershipStatus, TeamSessionCreationPolicy } from "@/storage/prisma";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { beforeAccountChangePublication, markAccountsChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import {
    isStructurallyValidSessionDataKeyEnvelope,
    readSessionDataKeyEnvelopeInTx,
    writeSessionDataKeyEnvelopeInTx,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import {
    resolveSessionAccessForOperation,
    type EffectiveSessionAccess,
} from "./sessionAccess";
import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";
import {
    resolveSubjectMemberAccountIdsInTx,
} from "./sessionGrantSubjects";
import { acquireSessionAccessTransitionCursorLocksInTx, applySessionAccessTransitionEffectsInTx } from "./sessionAccessTransitionEffects";
import type { SessionAccountCursorLockOptions } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import {
    resolveShareSubjectInTx,
    validateShareAccountSubjectIdentity,
    type ShareSubject,
    type ShareSubjectError,
} from "@/app/teams/shareEligibility";
import { gainsSessionAccessDelegationCapabilityV1, type SessionAccessGrantCapabilityValueV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { type SessionInitialAccessMaterializedV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import {
    enforceSessionContextExternalSharingPolicyInTx,
    enforceSessionGrantExternalSharingPolicyInTx,
    type SessionExternalSharingPolicyError,
} from "./sessionAccessExternalSharingPolicy";

/**
 * The only writer of Session access grants.
 *
 * Every Account, Team, and Group grant enters here so that one transaction makes
 * the final capability decision, the final subject-eligibility decision, and the
 * write itself.
 *
 * The service also owns the bounded before/after effective-access delta. Without
 * it, deleting one grant row looks identical to losing access, and a collaborator
 * who still reads the Session through an overlapping Team or Group grant would have
 * their draft tombstoned and their local Session deleted.
 */
export type SessionAccessGrantValue = SessionAccessGrantCapabilityValueV1;

/** Session wire codes keep their released `session_access_` prefix over the shared share-eligibility verdict. */
type SessionAccessGrantSubjectError = `session_access_${ShareSubjectError}`;

export type SessionAccessGrantErrorCode =
    | SessionAccessGrantSubjectError
    | DirectSessionRecipientEnvelopeError
    | "session_access_forbidden"
    | "session_access_session_not_found"
    | "session_access_permission_delegation_forbidden"
    | "session_access_permission_delegation_requires_edit"
    | "session_access_team_policy_required"
    | "session_access_authentication_required"
    | "session_access_authentication_unavailable"
    | SessionExternalSharingPolicyError;

export type SessionAccessGrantTransition = "inserted" | "replaced" | "unchanged";

export type SessionAccessDirectShareRow = Readonly<{
    id: string;
    sessionId: string;
    sharedByUserId: string;
    sharedWithUserId: string;
    accessLevel: ShareAccessLevel;
    canApprovePermissions: boolean;
    createdAt: Date;
    updatedAt: Date;
}>;

/**
 * What the outer transaction and the after-commit publisher need, and nothing more.
 *
 * `accountCursors` carries the coalesced AccountChange cursor per affected Account
 * so a released compatibility event can be built after commit without a second read.
 */
export type SessionAccessGrantEffects = Readonly<{
    changedAccountIds: readonly string[];
    /** Gained `readTranscript` where they previously had none. */
    grantedAccountIds: readonly string[];
    /** Lost `readTranscript` entirely, not merely downgraded. */
    revokedAccountIds: readonly string[];
    rosterManagerAccountIds: readonly string[];
    accountCursors: ReadonlyMap<string, AccountChangePublication>;
}>;

export type PutSessionAccessGrantResult =
    | Readonly<{
        ok: true;
        changed: boolean;
        transition: SessionAccessGrantTransition;
        subject: ShareSubject;
        value: SessionAccessGrantValue;
        requiredByTeamPolicy: boolean;
        directShare: SessionAccessDirectShareRow | null;
        effects: SessionAccessGrantEffects;
    }>
    | Readonly<{ ok: false; error: SessionAccessGrantErrorCode }>;

export type DeleteSessionAccessGrantResult =
    | Readonly<{
        ok: true;
        changed: boolean;
        subject: ShareSubject;
        removedDirectShare: SessionAccessDirectShareRow | null;
        effects: SessionAccessGrantEffects;
    }>
    | Readonly<{ ok: false; error: SessionAccessGrantErrorCode }>;

export type SetSessionAccessContextResult =
    | Readonly<{ ok: true; changed: boolean; primaryTeamId: string | null }>
    | Readonly<{ ok: false; error: SessionAccessGrantErrorCode }>;

/** Grant writes and compound callers admit the same complete audience before
 * authority reads. Retained Team memberships fence policy and native membership
 * changes, including Accounts not currently eligible to read the transcript. */
export function sessionAccessGrantMutationCursorLockOptions(input: Readonly<{
    actorAccountId: string;
    sessionId: string;
    subjects: readonly ShareSubject[];
}>): SessionAccountCursorLockOptions {
    return {
        intent: "exclusive",
        readAdditionalAccountIdsInTx: async tx => {
            const session = await tx.session.findUnique({
                where: { id: input.sessionId },
                select: {
                    primaryTeamId: true,
                    teamGrants: { select: { teamId: true } },
                    groupGrants: { select: { teamGroup: { select: { teamId: true } } } },
                },
            });
            const teamIds = [...new Set([
                ...(session?.primaryTeamId ? [session.primaryTeamId] : []),
                ...(session?.teamGrants.map(grant => grant.teamId) ?? []),
                ...(session?.groupGrants.map(grant => grant.teamGroup.teamId) ?? []),
                ...input.subjects.flatMap(subject => subject.kind === "account" ? [] : [subject.teamId]),
            ])];
            const memberships = teamIds.length === 0 ? [] : await tx.teamMembership.findMany({
                where: { teamId: { in: teamIds } }, select: { accountId: true },
            });
            return [input.actorAccountId, ...memberships.map(member => member.accountId),
                ...input.subjects.flatMap(subject => subject.kind === "account" ? [subject.accountId] : [])];
        },
    };
}

async function assertMutationCapabilityInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        sessionId: string;
        capability: "manageAccess" | "managePermissionDelegation";
        authentication: SessionAccessAuthentication;
    }>,
): Promise<"allowed" | "authentication_required" | "authentication_unavailable" | "forbidden"> {
    const decision = await resolveSessionAccessForOperation(tx, {
        accountId: input.actorAccountId,
        sessionId: input.sessionId,
        authentication: input.authentication,
        capability: input.capability,
    });
    if (decision.status === "authentication_required") return "authentication_required";
    if (decision.status === "authentication_unavailable") return "authentication_unavailable";
    return decision.status === "allowed" && decision.access.capabilities[input.capability]
        ? "allowed"
        : "forbidden";
}

function projectMutationAdmissionError(
    admission: Exclude<Awaited<ReturnType<typeof assertMutationCapabilityInTx>>, "allowed">,
): SessionAccessGrantErrorCode {
    if (admission === "authentication_required") return "session_access_authentication_required";
    if (admission === "authentication_unavailable") return "session_access_authentication_unavailable";
    return "session_access_forbidden";
}

/**
 * Admission-only seam for compound writes that carry an additional resource
 * reference. It uses the same canonical capability decision as the grant
 * writer, but lets the caller avoid validating/disclosing that secondary
 * reference before the actor is known to manage this Session. The writer still
 * repeats the check in its own transaction path.
 */
export async function assertSessionAccessManageAccessInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; sessionId: string; authentication: SessionAccessAuthentication }>,
): Promise<SessionAccessGrantErrorCode | null> {
    const admission = await assertMutationCapabilityInTx(tx, { ...input, capability: "manageAccess" });
    return admission === "allowed" ? null : projectMutationAdmissionError(admission);
}

/** The shared share-eligibility owner decides; Session callers receive its verdict under their wire prefix. */
async function resolveSessionGrantSubjectInTx(
    tx: Tx,
    params: Parameters<typeof resolveShareSubjectInTx>[1],
): Promise<Readonly<{ ok: true; subject: ShareSubject }> | Readonly<{ ok: false; error: SessionAccessGrantSubjectError }>> {
    const resolution = await resolveShareSubjectInTx(tx, params);
    return resolution.ok ? resolution : { ok: false, error: `session_access_${resolution.error}` };
}

async function validateSessionContextTeamInTx(
    tx: Tx,
    params: Readonly<{ actorAccountId: string; teamId: string }>,
): Promise<SessionAccessGrantErrorCode | null> {
    const team = await tx.team.findUnique({
        where: { id: params.teamId },
        select: { id: true, archivedAt: true },
    });
    if (!team) return "session_access_subject_not_found";
    if (team.archivedAt !== null) return "session_access_subject_ineligible";
    const membership = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: team.id, accountId: params.actorAccountId } },
        select: { status: true },
    });
    if (membership?.status !== TeamMembershipStatus.active) {
        return "session_access_subject_ineligible";
    }
    return null;
}

type InitialSessionAccessInput = Readonly<{
    creatorAccountId: string;
    sessionId: string;
    initialAccess: SessionInitialAccessMaterializedV1;
    authentication: SessionAccessAuthentication;
}>;

/** A failed initial admission must unwind the newborn Session and all publications. */
export class SessionInitialAccessError extends Error {
    constructor(readonly code: SessionAccessGrantErrorCode | "session_initial_access_creator_mismatch") {
        super(code);
        this.name = "SessionInitialAccessError";
    }
}

type InitialSessionAccessAdmission = Readonly<{
    ok: true;
    session: Readonly<{ accountId: string; primaryTeamId: string | null; encryptionMode: string }>;
    primaryTeam: Readonly<{ sessionCreationPolicy: TeamSessionCreationPolicy; archivedAt: Date | null }> | null;
    resolved: readonly Readonly<{
        subject: ShareSubject;
        grant: SessionAccessGrantValue;
        accountEnvelopeInput?: unknown;
    }>[];
    envelopeWrites: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}> | Readonly<{ ok: false; error: SessionAccessGrantErrorCode | "session_initial_access_creator_mismatch" }>;

/** Pure creation admission, reused after terminal Account locking without applying grants. */
async function admitInitialSessionAccessInTx(tx: Tx, params: InitialSessionAccessInput): Promise<InitialSessionAccessAdmission> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, primaryTeamId: true, encryptionMode: true },
    });
    if (!session) return { ok: false, error: "session_access_session_not_found" };
    const sessionEncryptionMode = session.encryptionMode === "plain"
        ? "plain"
        : session.encryptionMode === "e2ee"
            ? "e2ee"
            : null;
    if (sessionEncryptionMode === null) return { ok: false, error: "invalid_request" };

    if (session.primaryTeamId !== null) {
        const contextError = await validateSessionContextTeamInTx(tx, {
            actorAccountId: params.creatorAccountId,
            teamId: session.primaryTeamId,
        });
        if (contextError) return { ok: false, error: contextError };
    }
    if (session.accountId !== params.creatorAccountId) {
        return { ok: false, error: "session_initial_access_creator_mismatch" };
    }

    const grants = [...params.initialAccess.grants];
    const resolved: Array<{
        subject: ShareSubject;
        grant: SessionAccessGrantValue;
        accountEnvelopeInput?: unknown;
    }> = [];
    const envelopeWrites = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const grant of grants) {
        const subject = await resolveSessionGrantSubjectInTx(tx, {
            actorAccountId: params.creatorAccountId,
            resourceOwnerAccountId: session.accountId,
            subject: grant.subject,
            hasExistingGrant: false,
        });
        if (!subject.ok) return { ok: false, error: subject.error };
        const value = normalizeGrantValue(grant);
        const accountEnvelopeInput = grant.subject.kind === "account" && "accountEnvelopeInput" in grant
            ? grant.accountEnvelopeInput
            : undefined;
        if (subject.subject.kind === "account") {
            if (sessionEncryptionMode === "plain") {
                if (accountEnvelopeInput !== undefined) {
                    return { ok: false, error: "data_key_not_required" };
                }
            } else {
                const recipient = await tx.account.findUniqueOrThrow({
                    where: { id: subject.subject.accountId },
                    select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
                });
                const admission = admitDirectSessionRecipientEnvelope({
                    sessionEncryptionMode,
                    recipientReadiness: deriveAccountRecipientEnvelopeReadinessFromRow(recipient),
                    hasExistingEnvelope: false,
                    input: accountEnvelopeInput,
                });
                if (admission.outcome === "rejected") return { ok: false, error: admission.error };
                if (admission.outcome === "write") {
                    envelopeWrites.set(subject.subject.accountId, decodeBase64(admission.encryptedDataKey));
                }
            }
        }
        resolved.push({ subject: subject.subject, grant: value, accountEnvelopeInput });
    }
    const primaryTeam = session.primaryTeamId
        ? await tx.team.findUnique({
            where: { id: session.primaryTeamId },
            select: { sessionCreationPolicy: true, archivedAt: true },
        })
        : null;
    const primaryTeamGrant = resolved.find(
        (item) => item.subject.kind === "team" && item.subject.teamId === session.primaryTeamId,
    );
    if (teamPolicyRequiresGrant(primaryTeam) && session.primaryTeamId) {
        if (!primaryTeamGrant) {
            resolved.push({
                subject: { kind: "team", teamId: session.primaryTeamId },
                grant: applyRequiredTeamGrantFloor(null),
            });
        } else {
            primaryTeamGrant.grant = applyRequiredTeamGrantFloor(primaryTeamGrant.grant);
        }
    }

    for (const item of resolved) {
        const policyError = await enforceSessionGrantExternalSharingPolicyInTx(tx, {
            actorAccountId: params.creatorAccountId,
            primaryTeamId: session.primaryTeamId,
            subject: item.subject,
            previous: null,
            next: item.grant,
            authentication: params.authentication,
        });
        if (policyError) return { ok: false, error: policyError };
    }

    return { ok: true, session, primaryTeam, resolved, envelopeWrites };
}

/** Apply creation-time grants as one materialization step. */
export async function applyInitialSessionAccessInTx(
    tx: Tx,
    params: InitialSessionAccessInput,
): Promise<Readonly<{
    ok: true;
    effects: SessionAccessGrantEffects;
    directShares: readonly SessionAccessDirectShareRow[];
}> | Readonly<{ ok: false; error: SessionAccessGrantErrorCode | "session_initial_access_creator_mismatch" }>> {
    const admission = await admitInitialSessionAccessInTx(tx, params);
    if (!admission.ok) return admission;
    const { session, primaryTeam, resolved, envelopeWrites } = admission;
    if (params.initialAccess.grants.length > 0 || session.primaryTeamId !== null) {
        beforeAccountChangePublication(tx, [params.creatorAccountId], async client => {
            const current = await admitInitialSessionAccessInTx(client, params);
            if (!current.ok) throw new SessionInitialAccessError(current.error);
            // Policy changes may alter the implicit required grant/floor. Replay
            // the whole materialization instead of committing the old grants.
            if (!isDeepStrictEqual(current.resolved, resolved)
                || teamPolicyRequiresGrant(current.primaryTeam) !== teamPolicyRequiresGrant(primaryTeam)) {
                throw new TransactionReplayRequiredError("session-initial-access-admission-changed");
            }
        });
    }

    // A private creation with no requested grants has no access transition to
    // publish. In particular, do not invalidate the owner's roster merely
    // because the owner is implicitly readable/manageable.
    if (resolved.length === 0) return { ok: true, effects: EMPTY_EFFECTS, directShares: [] };

    const affected = new Set<string>();
    for (const item of resolved) {
        for (const accountId of await resolveAffectedAccountIdsInTx(tx, item.subject)) {
            if (accountId !== session.accountId) affected.add(accountId);
        }
    }
    const before = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: [...affected],
    });
    const directShares: SessionAccessDirectShareRow[] = [];
    for (const item of resolved) {
        if (item.subject.kind === "account") {
            directShares.push(await tx.sessionShare.create({
                data: {
                    sessionId: params.sessionId,
                    sharedByUserId: params.creatorAccountId,
                    sharedWithUserId: item.subject.accountId,
                    accessLevel: item.grant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: item.grant.canApprovePermissions,
                },
            }));
            const encryptedDataKey = envelopeWrites.get(item.subject.accountId);
            if (encryptedDataKey) {
                const envelopeWrite = await writeSessionDataKeyEnvelopeInTx(tx, {
                    sessionId: params.sessionId,
                    recipientAccountId: item.subject.accountId,
                    encryptedDataKey,
                    markRecipientChanged: false,
                });
                if (!envelopeWrite.ok) throw new Error("Admitted session recipient envelope failed persistence validation");
            }
        } else if (item.subject.kind === "team") {
            await tx.sessionTeamGrant.create({
                data: {
                    sessionId: params.sessionId,
                    teamId: item.subject.teamId,
                    accessLevel: item.grant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: item.grant.canApprovePermissions,
                    requiredByTeamPolicy: primaryTeam?.sessionCreationPolicy === TeamSessionCreationPolicy.team_required && item.subject.teamId === session.primaryTeamId,
                    effectiveAt: await readTransactionDatabaseTime(tx),
                },
            });
        } else {
            await tx.sessionGroupGrant.create({
                data: {
                    sessionId: params.sessionId,
                    teamGroupId: item.subject.groupId,
                    accessLevel: item.grant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: item.grant.canApprovePermissions,
                    effectiveAt: await readTransactionDatabaseTime(tx),
                },
            });
        }
    }
    const after = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: [...affected],
    });
    const effects = await applyGrantTransitionEffectsInTx(tx, {
        sessionId: params.sessionId,
        actorAccountId: params.creatorAccountId,
        sessionOwnerAccountId: session.accountId,
        before,
        after,
    });
    return { ok: true, effects, directShares };
}

const EMPTY_EFFECTS: SessionAccessGrantEffects = {
    changedAccountIds: [],
    grantedAccountIds: [],
    revokedAccountIds: [],
    rosterManagerAccountIds: [],
    accountCursors: new Map(),
};

/** View can never carry permission approval, so a View grant normalizes it away. */
function normalizeGrantValue(value: SessionAccessGrantValue): SessionAccessGrantValue {
    return value.accessLevel === "view"
        ? { accessLevel: "view", canApprovePermissions: false }
        : value;
}

/** One policy-floor decision shared by fresh materialization and live context changes. */
function applyRequiredTeamGrantFloor(value: SessionAccessGrantValue | null): SessionAccessGrantValue {
    return value === null || value.accessLevel === "view"
        ? { accessLevel: "edit", canApprovePermissions: false }
        : value;
}

function sameEncryptedDataKey(a: Uint8Array | null, b: Uint8Array | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

type StoredGrant = Readonly<{
    accessLevel: ShareAccessLevel;
    canApprovePermissions: boolean;
    requiredByTeamPolicy: boolean;
}>;

async function loadStoredGrantInTx(
    tx: Tx,
    sessionId: string,
    subject: ShareSubject,
): Promise<{ stored: StoredGrant | null; directShare: SessionAccessDirectShareRow | null }> {
    if (subject.kind === "account") {
        const share = await tx.sessionShare.findUnique({
            where: {
                sessionId_sharedWithUserId: { sessionId, sharedWithUserId: subject.accountId },
            },
        });
        if (!share) return { stored: null, directShare: null };
        return {
            stored: {
                accessLevel: share.accessLevel,
                canApprovePermissions: share.canApprovePermissions,
                requiredByTeamPolicy: false,
            },
            directShare: share,
        };
    }
    if (subject.kind === "team") {
        const grant = await tx.sessionTeamGrant.findUnique({
            where: { sessionId_teamId: { sessionId, teamId: subject.teamId } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        });
        return { stored: grant ?? null, directShare: null };
    }
    const grant = await tx.sessionGroupGrant.findUnique({
        where: { sessionId_teamGroupId: { sessionId, teamGroupId: subject.groupId } },
        select: { accessLevel: true, canApprovePermissions: true },
    });
    return {
        stored: grant ? { ...grant, requiredByTeamPolicy: false } : null,
        directShare: null,
    };
}

/**
 * The one condition behind the required-Team floor, over a Team row the caller
 * already holds. The creation path reads the primary Team for other reasons and
 * used to restate this rule inline; both sites now ask this.
 */
function teamPolicyRequiresGrant(
    team: Readonly<{ sessionCreationPolicy: TeamSessionCreationPolicy; archivedAt: Date | null }> | null,
): boolean {
    return team !== null
        && team.archivedAt === null
        && team.sessionCreationPolicy === TeamSessionCreationPolicy.team_required;
}

/**
 * A Team policy that still requires this Session's Team grant blocks weakening or
 * removing it. When the policy has been relaxed, this explicit authorized edit is
 * also where the now-stale marker is cleared: there is no bulk relaxation job.
 */
export async function teamPolicyStillRequiresGrant(tx: Tx, teamId: string): Promise<boolean> {
    return (await teamsPolicyStillRequireGrants(tx, [teamId])).has(teamId);
}

/** Evaluate the same required-Team floor once for a complete grant roster. */
export async function teamsPolicyStillRequireGrants(tx: Tx, teamIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (teamIds.length === 0) return new Set();
    const teams = (await Promise.all(portableQueryChunks({ values: [...new Set(teamIds)], bindingsPerValue: 1, fixedBindings: 1 }).map(ids => tx.team.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, sessionCreationPolicy: true, archivedAt: true },
    })))).flat();
    return new Set(teams.filter(teamPolicyRequiresGrant).map((team) => team.id));
}

async function resolveAffectedAccountIdsInTx(
    tx: Tx,
    subject: ShareSubject,
): Promise<string[]> {
    if (subject.kind === "account") return [subject.accountId];
    return await resolveSubjectMemberAccountIdsInTx(
        tx,
        subject.kind === "team"
            ? { kind: "team", teamId: subject.teamId }
            : { kind: "group", teamId: subject.teamId, groupId: subject.groupId },
    );
}

/** Pure birth census; grant eligibility and envelope validation remain with the writer. */
export async function readInitialSessionAccessAccountIdsInTx(tx: Tx, input: Readonly<{
    initialAccess?: SessionInitialAccessMaterializedV1;
    primaryTeamId?: string | null;
}>): Promise<readonly string[]> {
    const subjects = (input.initialAccess?.grants ?? []).map(grant => grant.subject);
    if (input.primaryTeamId && await teamPolicyStillRequiresGrant(tx, input.primaryTeamId)
        && !subjects.some(subject => subject.kind === "team" && subject.teamId === input.primaryTeamId)) {
        subjects.push({ kind: "team", teamId: input.primaryTeamId });
    }
    const accounts = new Set<string>();
    for (const subject of subjects) {
        for (const accountId of await resolveAffectedAccountIdsInTx(tx, subject)) accounts.add(accountId);
    }
    return [...accounts].sort();
}

/** Grant changes also invalidate the explicit roster for its current managers. */
async function applyGrantTransitionEffectsInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        actorAccountId: string;
        sessionOwnerAccountId: string;
        before: ReadonlyMap<string, EffectiveSessionAccess | null>;
        after: ReadonlyMap<string, EffectiveSessionAccess | null>;
        directGrantChangedAccountId?: string;
    }>,
): Promise<SessionAccessGrantEffects> {
    const rosterManagerAccountIds = new Set<string>();
    const currentAccess = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: params.sessionId }),
    });
    for (const [accountId, access] of currentAccess) {
        if (access?.capabilities.manageAccess) rosterManagerAccountIds.add(accountId);
    }
    const effects = await applySessionAccessTransitionEffectsInTx(tx, { ...params, additionalPublicationAccountIds: [...rosterManagerAccountIds] });
    const accountCursors = new Map(effects.accountCursors);
    for (const publication of await markAccountsChanged(tx, { accountIds: [...rosterManagerAccountIds], kind: "share", entityId: params.sessionId })) {
        // Roster publication follows the access projection for this Account,
        // so its terminal cursor is the newest one without eager resolution.
        accountCursors.set(publication.accountId, publication);
    }
    return { ...effects, rosterManagerAccountIds: [...rosterManagerAccountIds], accountCursors };
}

export async function putSessionAccessGrantInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        sessionId: string;
        subject: ShareSubject;
        grant: SessionAccessGrantValue;
        accountEnvelopeInput?: unknown;
        /** Verified request/runtime credential context supplied by the entry point. */
        authentication: SessionAccessAuthentication;
    }>,
): Promise<PutSessionAccessGrantResult> {
    await acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId], [],
        sessionAccessGrantMutationCursorLockOptions({ ...params, subjects: [params.subject] }));
    const admission = await assertMutationCapabilityInTx(tx, { ...params, capability: "manageAccess" });
    if (admission !== "allowed") return {
        ok: false,
        error: projectMutationAdmissionError(admission),
    };

    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: {
            id: true,
            accountId: true,
            primaryTeamId: true,
            encryptionMode: true,
        },
    });
    if (!session) return { ok: false, error: "session_access_session_not_found" };
    const sessionEncryptionMode = session.encryptionMode === "plain"
        ? "plain"
        : session.encryptionMode === "e2ee"
            ? "e2ee"
            : null;
    if (sessionEncryptionMode === null) return { ok: false, error: "invalid_request" };

    // Transcript shareability is a disclosure rule, not an admission rule: a grant
    // on a not-yet-published Session pre-authorizes its recipient, and
    // `projectEffectiveSessionAccess` withholds every non-owner decision until the
    // transcript publishes. Initial access has always composed grants this way; the
    // edit path must not decide the same question a second time.
    if (params.grant.canApprovePermissions && params.grant.accessLevel === "view") {
        return { ok: false, error: "session_access_permission_delegation_requires_edit" };
    }
    const value = normalizeGrantValue(params.grant);

    const { stored, directShare: storedDirectShare } = await loadStoredGrantInTx(
        tx,
        params.sessionId,
        params.subject,
    );

    const resolution = await resolveSessionGrantSubjectInTx(tx, {
        actorAccountId: params.actorAccountId,
        resourceOwnerAccountId: session.accountId,
        subject: params.subject,
        hasExistingGrant: stored !== null,
    });
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const subject = resolution.subject;

    const externalPolicyError = await enforceSessionGrantExternalSharingPolicyInTx(tx, {
        actorAccountId: params.actorAccountId,
        primaryTeamId: session.primaryTeamId,
        subject,
        previous: stored,
        next: value,
        authentication: params.authentication,
    });
    if (externalPolicyError) return { ok: false, error: externalPolicyError };

    // Require delegation authority only when this row newly creates the effective
    // permission-manager capability. Retaining or reducing it is not escalation;
    // an Admin upgrade that combines with a retained flag is.
    if (gainsSessionAccessDelegationCapabilityV1(stored, value)) {
        const delegation = await assertMutationCapabilityInTx(tx, {
            ...params,
            capability: "managePermissionDelegation",
        });
        if (delegation !== "allowed") {
            return {
                ok: false,
                error: delegation === "authentication_required"
                    ? "session_access_authentication_required"
                    : delegation === "authentication_unavailable"
                        ? "session_access_authentication_unavailable"
                        : "session_access_permission_delegation_forbidden",
            };
        }
    }

    // A required Team grant cannot be weakened while the policy still requires it.
    // Once the policy is relaxed, this explicit authorized edit is also where the
    // now-stale marker is cleared; there is no bulk relaxation job.
    let requiredByTeamPolicy = stored?.requiredByTeamPolicy ?? false;
    if (subject.kind === "team" && requiredByTeamPolicy) {
        const stillRequired = await teamPolicyStillRequiresGrant(tx, subject.teamId);
        const weakening = value.accessLevel === "view" && stored?.accessLevel !== "view";
        if (stillRequired && weakening) {
            return { ok: false, error: "session_access_team_policy_required" };
        }
        requiredByTeamPolicy = stillRequired;
    }

    let storedEnvelope: Uint8Array | null = null;
    let envelopeToWrite: Uint8Array | null = null;
    if (subject.kind !== "account") {
        if (params.accountEnvelopeInput !== undefined) {
            return { ok: false, error: "invalid_request" };
        }
    } else if (sessionEncryptionMode === "plain") {
        // Persisted Session mode is the authority. Plain grants neither inspect
        // recipient crypto readiness nor touch the envelope table; supplied
        // material is rejected.
        if (params.accountEnvelopeInput !== undefined) {
            return { ok: false, error: "data_key_not_required" };
        }
    } else {
        storedEnvelope = await readSessionDataKeyEnvelopeInTx(tx, {
            sessionId: params.sessionId,
            recipientAccountId: subject.accountId,
        });
        const recipient = await tx.account.findUniqueOrThrow({
            where: { id: subject.accountId },
            select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
        });
        const envelopeAdmission = admitDirectSessionRecipientEnvelope({
            sessionEncryptionMode,
            recipientReadiness: deriveAccountRecipientEnvelopeReadinessFromRow(recipient),
            hasExistingEnvelope: storedEnvelope !== null && isStructurallyValidSessionDataKeyEnvelope(storedEnvelope),
            input: params.accountEnvelopeInput,
        });
        if (envelopeAdmission.outcome === "rejected") return { ok: false, error: envelopeAdmission.error };
        if (envelopeAdmission.outcome === "write") envelopeToWrite = decodeBase64(envelopeAdmission.encryptedDataKey);
    }
    const envelopeChanges = envelopeToWrite !== null && !sameEncryptedDataKey(storedEnvelope, envelopeToWrite);
    const valueChanges = stored === null
        || stored.accessLevel !== value.accessLevel
        || stored.canApprovePermissions !== value.canApprovePermissions
        || stored.requiredByTeamPolicy !== requiredByTeamPolicy;

    if (!valueChanges && !envelopeChanges) {
        return {
            ok: true,
            changed: false,
            transition: "unchanged",
            subject,
            value,
            requiredByTeamPolicy,
            directShare: storedDirectShare,
            effects: EMPTY_EFFECTS,
        };
    }

    const affectedAccountIds = await resolveAffectedAccountIdsInTx(tx, subject);
    const before = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: affectedAccountIds,
    });

    let directShare: SessionAccessDirectShareRow | null = null;
    if (subject.kind === "account") {
        directShare = await tx.sessionShare.upsert({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: params.sessionId,
                    sharedWithUserId: subject.accountId,
                },
            },
            create: {
                sessionId: params.sessionId,
                sharedByUserId: params.actorAccountId,
                sharedWithUserId: subject.accountId,
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
            },
            update: {
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
            },
        });
        // Grant and envelope commit together, so a recipient never sees access
        // without the key the same request sealed for them, and a rejected
        // envelope rolls the grant back with it.
        if (envelopeChanges && envelopeToWrite !== null) {
            const envelopeWrite = await writeSessionDataKeyEnvelopeInTx(tx, {
                sessionId: params.sessionId,
                recipientAccountId: subject.accountId,
                encryptedDataKey: envelopeToWrite,
                // The transition effects below publish this recipient's change,
                // including when only the envelope moved.
                markRecipientChanged: false,
            });
            if (!envelopeWrite.ok) throw new Error("Admitted session recipient envelope failed persistence validation");
        }
    } else if (subject.kind === "team") {
        // `effectiveAt` is minted once from the database clock and is never rewritten
        // by a later replacement: it is the only fact that decides a `from_membership`
        // member's historical access, so it is not a last-modified timestamp. Insert
        // and update are separate statements precisely so no update path can touch it.
        if (stored === null) {
            await tx.sessionTeamGrant.create({
                data: {
                    sessionId: params.sessionId,
                    teamId: subject.teamId,
                    accessLevel: value.accessLevel as ShareAccessLevel,
                    canApprovePermissions: value.canApprovePermissions,
                    requiredByTeamPolicy,
                    effectiveAt: await readTransactionDatabaseTime(tx),
                },
            });
        } else {
            await tx.sessionTeamGrant.update({
                where: { sessionId_teamId: { sessionId: params.sessionId, teamId: subject.teamId } },
                data: {
                    accessLevel: value.accessLevel as ShareAccessLevel,
                    canApprovePermissions: value.canApprovePermissions,
                    requiredByTeamPolicy,
                },
            });
        }
    } else if (stored === null) {
        await tx.sessionGroupGrant.create({
            data: {
                sessionId: params.sessionId,
                teamGroupId: subject.groupId,
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
                effectiveAt: await readTransactionDatabaseTime(tx),
            },
        });
    } else {
        await tx.sessionGroupGrant.update({
            where: {
                sessionId_teamGroupId: {
                    sessionId: params.sessionId,
                    teamGroupId: subject.groupId,
                },
            },
            data: {
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
            },
        });
    }

    const after = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: affectedAccountIds,
    });
    const effects = await applyGrantTransitionEffectsInTx(tx, {
        sessionId: params.sessionId,
        actorAccountId: params.actorAccountId,
        sessionOwnerAccountId: session.accountId,
        before,
        after,
        ...(subject.kind === "account" ? { directGrantChangedAccountId: subject.accountId } : {}),
    });


    return {
        ok: true,
        changed: true,
        transition: stored === null ? "inserted" : "replaced",
        subject,
        value,
        requiredByTeamPolicy,
        directShare,
        effects,
    };
}

export async function deleteSessionAccessGrantInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        sessionId: string;
        subject: ShareSubject;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<DeleteSessionAccessGrantResult> {
    await acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId], [],
        sessionAccessGrantMutationCursorLockOptions({ ...params, subjects: [params.subject] }));
    // Authorize before revealing whether the grant exists, so removal cannot be
    // used to probe another Session's roster.
    const admission = await assertMutationCapabilityInTx(tx, { ...params, capability: "manageAccess" });
    if (admission !== "allowed") return {
        ok: false,
        error: projectMutationAdmissionError(admission),
    };

    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { id: true, accountId: true },
    });
    if (!session) return { ok: false, error: "session_access_session_not_found" };

    if (params.subject.kind === "account") {
        const identityError = validateShareAccountSubjectIdentity({
            actorAccountId: params.actorAccountId,
            resourceOwnerAccountId: session.accountId,
            subjectAccountId: params.subject.accountId,
        });
        if (identityError) return { ok: false, error: `session_access_${identityError}` };
    }

    const { stored, directShare } = await loadStoredGrantInTx(tx, params.sessionId, params.subject);
    if (!stored) {
        // Idempotent: a retry after a lost response, or a subject already removed by
        // a membership/directory cascade, succeeds without requiring the subject to
        // still exist and without scheduling any effect.
        return {
            ok: true,
            changed: false,
            subject: params.subject,
            removedDirectShare: null,
            effects: EMPTY_EFFECTS,
        };
    }

    // An existing row makes deletion independent of current discovery
    // eligibility, but it does not make the caller's subject claim authoritative.
    // Reuse the canonical subject resolver so owner/self direct grants and a
    // mismatched Group parent Team cannot bypass the sole grant writer.
    const resolution = await resolveSessionGrantSubjectInTx(tx, {
        actorAccountId: params.actorAccountId,
        resourceOwnerAccountId: session.accountId,
        subject: params.subject,
        hasExistingGrant: true,
        removingExistingGrant: true,
    });
    if (!resolution.ok) return { ok: false, error: resolution.error };
    const subject = resolution.subject;

    if (subject.kind === "team"
        && stored.requiredByTeamPolicy
        && await teamPolicyStillRequiresGrant(tx, subject.teamId)) {
        return { ok: false, error: "session_access_team_policy_required" };
    }

    const affectedAccountIds = await resolveAffectedAccountIdsInTx(tx, subject);
    const before = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: affectedAccountIds,
    });

    if (subject.kind === "account") {
        await tx.sessionShare.delete({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: params.sessionId,
                    sharedWithUserId: subject.accountId,
                },
            },
        });
    } else if (subject.kind === "team") {
        await tx.sessionTeamGrant.delete({
            where: { sessionId_teamId: { sessionId: params.sessionId, teamId: subject.teamId } },
        });
    } else {
        await tx.sessionGroupGrant.delete({
            where: {
                sessionId_teamGroupId: {
                    sessionId: params.sessionId,
                    teamGroupId: subject.groupId,
                },
            },
        });
    }

    const after = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: affectedAccountIds,
    });
    const effects = await applyGrantTransitionEffectsInTx(tx, {
        sessionId: params.sessionId,
        actorAccountId: params.actorAccountId,
        sessionOwnerAccountId: session.accountId,
        before,
        after,
        ...(subject.kind === "account"
            ? { directGrantChangedAccountId: subject.accountId }
            : {}),
    });

    return {
        ok: true,
        changed: true,
        subject,
        removedDirectShare: directShare,
        effects,
    };
}

/**
 * The only writer of the authored Session Team context. Context remains a
 * descriptive fact, while the Team-required creation policy is composed here
 * through the same grant tables and transition owners as every other access
 * change. This keeps the context, its required marker, and the minimum Team
 * grant atomic without introducing a second grant service. While that marker's
 * active Team still requires the context, clearing or replacing it is rejected;
 * governance may relax/archive the Team first, after which the ordinary
 * manageAccess actor performs the explicit context edit.
 */
export async function setSessionAccessContextInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        sessionId: string;
        primaryTeamId: string | null;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<SetSessionAccessContextResult> {
    await acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId], [],
        sessionAccessGrantMutationCursorLockOptions({ ...params,
            subjects: params.primaryTeamId === null ? [] : [{ kind: "team", teamId: params.primaryTeamId }],
        }));
    const admission = await assertMutationCapabilityInTx(tx, { ...params, capability: "manageAccess" });
    if (admission !== "allowed") return {
        ok: false,
        error: projectMutationAdmissionError(admission),
    };

    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true, primaryTeamId: true },
    });
    if (!session) return { ok: false, error: "session_access_session_not_found" };

    const markerState = await tx.sessionTeamGrant.findMany({
        where: { sessionId: params.sessionId, requiredByTeamPolicy: true },
        select: { teamId: true },
    });
    if (session.primaryTeamId !== params.primaryTeamId
        && session.primaryTeamId !== null
        && markerState.some(marker => marker.teamId === session.primaryTeamId)
        && await teamPolicyStillRequiresGrant(tx, session.primaryTeamId)) {
        return { ok: false, error: "session_access_team_policy_required" };
    }

    let targetTeamRequired = false;
    let targetTeamGrant: Readonly<{
        accessLevel: ShareAccessLevel;
        canApprovePermissions: boolean;
    }> | null = null;
    if (params.primaryTeamId !== null) {
        const contextError = await validateSessionContextTeamInTx(tx, {
            actorAccountId: params.actorAccountId,
            teamId: params.primaryTeamId,
        });
        if (contextError) return { ok: false, error: contextError };
        const team = await tx.team.findUniqueOrThrow({
            where: { id: params.primaryTeamId },
            select: { sessionCreationPolicy: true },
        });

        targetTeamRequired = team.sessionCreationPolicy === TeamSessionCreationPolicy.team_required;
        if (targetTeamRequired) {
            targetTeamGrant = await tx.sessionTeamGrant.findUnique({
                where: { sessionId_teamId: { sessionId: params.sessionId, teamId: params.primaryTeamId } },
                select: { accessLevel: true, canApprovePermissions: true },
            });
        }
    }

    if (session.primaryTeamId !== params.primaryTeamId) {
        const externalPolicyError = await enforceSessionContextExternalSharingPolicyInTx(tx, {
            actorAccountId: params.actorAccountId,
            sessionId: params.sessionId,
            primaryTeamId: params.primaryTeamId,
            authentication: params.authentication,
        });
        if (externalPolicyError) return { ok: false, error: externalPolicyError };
    }

    const markerAlreadyCorrect = markerState.length === (targetTeamRequired ? 1 : 0)
        && (targetTeamRequired ? markerState[0]?.teamId === params.primaryTeamId : true);
    const requiredGrantNeedsFloor = targetTeamRequired
        && (targetTeamGrant === null || targetTeamGrant.accessLevel === ShareAccessLevel.view);
    const changed = session.primaryTeamId !== params.primaryTeamId
        || !markerAlreadyCorrect
        || requiredGrantNeedsFloor;
    if (!changed) return { ok: true, changed: false, primaryTeamId: session.primaryTeamId };

    const affectedAccountIds = new Set(
        await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: params.sessionId }),
    );
    affectedAccountIds.add(session.accountId);
    if (targetTeamRequired && params.primaryTeamId !== null) {
        for (const accountId of await resolveAffectedAccountIdsInTx(tx, {
            kind: "team",
            teamId: params.primaryTeamId,
        })) {
            affectedAccountIds.add(accountId);
        }
    }
    const before = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: [...affectedAccountIds],
    });

    await tx.session.update({ where: { id: params.sessionId }, data: { primaryTeamId: params.primaryTeamId } });
    await tx.sessionTeamGrant.updateMany({
        where: {
            sessionId: params.sessionId,
            requiredByTeamPolicy: true,
            ...(targetTeamRequired && params.primaryTeamId !== null
                ? { teamId: { not: params.primaryTeamId } }
                : {}),
        },
        data: { requiredByTeamPolicy: false },
    });
    if (targetTeamRequired && params.primaryTeamId !== null) {
        const key = { sessionId: params.sessionId, teamId: params.primaryTeamId };
        const requiredGrant = applyRequiredTeamGrantFloor(targetTeamGrant);
        if (targetTeamGrant === null) {
            await tx.sessionTeamGrant.create({
                data: {
                    ...key,
                    accessLevel: requiredGrant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: requiredGrant.canApprovePermissions,
                    requiredByTeamPolicy: true,
                    effectiveAt: await readTransactionDatabaseTime(tx),
                },
            });
        } else {
            await tx.sessionTeamGrant.update({
                where: { sessionId_teamId: key },
                data: {
                    ...(targetTeamGrant.accessLevel === ShareAccessLevel.view
                        ? {
                            accessLevel: requiredGrant.accessLevel as ShareAccessLevel,
                            canApprovePermissions: requiredGrant.canApprovePermissions,
                        }
                        : {}),
                    requiredByTeamPolicy: true,
                },
            });
        }
    }

    const after = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: [...affectedAccountIds],
    });
    const effects = await applyGrantTransitionEffectsInTx(tx, {
        sessionId: params.sessionId,
        actorAccountId: params.actorAccountId,
        sessionOwnerAccountId: session.accountId,
        before,
        after,
    });
    return { ok: true, changed: true, primaryTeamId: params.primaryTeamId };
}

/** Entry discovery and cleanup share the authored-or-received retained-share predicate. */
export async function readSessionAccessGrantsForAccountErasureInTx(tx: Tx, accountId: string) {
    const shares = await tx.sessionShare.findMany({
        where: {
            OR: [{ sharedByUserId: accountId }, { sharedWithUserId: accountId }],
        },
        select: {
            id: true,
            sessionId: true,
            sharedWithUserId: true,
            session: { select: { accountId: true } },
        },
        orderBy: [{ sessionId: "asc" }, { id: "asc" }],
    });
    // Filter only this Account's grant results: a relational owner inequality
    // lets PostgreSQL drive the join from unrelated Home Sessions instead.
    return shares.filter(share => share.session.accountId !== accountId);
}

/**
 * Removes an erased Account's received grants and preserves the grants it merely
 * authored on surviving Sessions. The physical Account-erasure owner supplies the
 * admission and transaction; this is not a manager-authorized grant API.
 *
 * `sharedByUserId` remains non-null compatibility provenance, so each retained
 * grant moves to its own Session owner without changing access or key material.
 * Owned Sessions retain their grants until the Session-deletion lifecycle gathers
 * its recipients and cascades them. Access logs keep their existing cascade and
 * Account-erasure policies.
 */
export async function eraseSessionAccessGrantsForAccountInTx(
    tx: Tx,
    params: Readonly<{ accountId: string }>,
): Promise<void> {
    const readShares = () => readSessionAccessGrantsForAccountErasureInTx(tx, params.accountId);
    const capturedShares = await readShares();
    if (capturedShares.length === 0) return;
    // Retirement has closed new grants received or authored by this Account.
    // Surviving Session owners can still remove a captured share, so use the
    // ordinary grant-transition fence before reading access or changing rows.
    // Reread after the fence: a share removed during discovery is already gone.
    await acquireSessionAccessTransitionCursorLocksInTx(tx,
        [...new Set(capturedShares.map(share => share.sessionId))], [params.accountId]);
    const shares = await readShares();
    for (const share of shares) {
        const accountIds = [share.sharedWithUserId];
        const before = await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: share.sessionId,
            accountIds,
        });
        if (share.sharedWithUserId === params.accountId) {
            await tx.sessionShare.delete({ where: { id: share.id } });
        } else {
            await tx.sessionShare.update({
                where: { id: share.id },
                data: { sharedByUserId: share.session.accountId },
            });
        }
        const after = await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: share.sessionId,
            accountIds,
        });
        await applyGrantTransitionEffectsInTx(tx, {
            sessionId: share.sessionId,
            actorAccountId: params.accountId,
            sessionOwnerAccountId: share.session.accountId,
            before,
            after,
            directGrantChangedAccountId: share.sharedWithUserId,
        });
    }
}
