import type { SessionGrant } from '@prisma/client';
import { resolveStructuralSessionAccessForAccountsInTx } from "./sessionAccess";
import { decodeBase64 } from "privacy-kit";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "./sessionRecipients";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { admitDirectSessionRecipientEnvelope, type DirectSessionRecipientEnvelopeError } from "@/app/session/encryption/sessionDataKeyEnvelopeAdmission";
import { inTx, type Tx } from "@/storage/inTx";
import { ShareAccessLevel, TeamSessionCreationPolicy } from "@/storage/prisma";
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE } from "@/app/teams/memberships/effectiveMembership";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { markAccountsChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import {
    isStructurallyValidSessionDataKeyEnvelope,
    readSessionDataKeyEnvelopeInTx,
    writeSessionDataKeyEnvelopeInTx,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import {
    resolveSessionAccessForOperation,
    type EffectiveSessionAccess,
} from "./sessionAccess";
import { qualifySessionTeamAuthenticationInTx, type SessionAccessAuthentication } from "./sessionAccessAuthentication";
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
import type { SetSessionAccessContextResponseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
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

/** Released direct-share events keep their established shape over the unified Account grant. */
function projectDirectSessionGrant(row: SessionGrant): SessionAccessDirectShareRow {
    return { id: row.id, sessionId: row.sessionId, sharedByUserId: row.createdByAccountId!, sharedWithUserId: row.accountId!,
        accessLevel: row.accessLevel, canApprovePermissions: row.canApprovePermissions, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

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
    | (Readonly<{ ok: true }> & SetSessionAccessContextResponseV1)
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
                    grants: { where: { principalKind: { in: ['team', 'group'] } },
                        select: { teamId: true, teamGroup: { select: { teamId: true } } } },
                },
            });
            const teamIds = [...new Set([
                ...(session?.primaryTeamId ? [session.primaryTeamId] : []),
                ...(session?.grants.flatMap(grant => grant.teamId ? [grant.teamId] : grant.teamGroup ? [grant.teamGroup.teamId] : []) ?? []),
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

/** Share eligibility admits the subject. A new Team attachment also qualifies the credential. */
async function resolveSessionGrantSubjectInTx(
    tx: Tx,
    params: Parameters<typeof resolveShareSubjectInTx>[1] & Readonly<{
        authentication: SessionAccessAuthentication;
        admittedPrimaryTeamId?: string;
    }>,
): Promise<Readonly<{ ok: true; subject: ShareSubject }> | Readonly<{ ok: false; error: SessionAccessGrantErrorCode }>> {
    const resolution = await resolveShareSubjectInTx(tx, params);
    if (!resolution.ok) return { ok: false, error: `session_access_${resolution.error}` };
    const { subject } = resolution;
    if (subject.kind === "team" && !params.hasExistingGrant && !params.removingExistingGrant
        && subject.teamId !== params.admittedPrimaryTeamId) {
        const team = await tx.team.findUniqueOrThrow({
            where: { id: subject.teamId },
            select: { id: true, authenticationPolicy: true },
        });
        const error = await qualifySessionAttachmentTeamInTx(tx, {
            accountId: params.actorAccountId, team, authentication: params.authentication,
        });
        if (error) return { ok: false, error };
    }
    return resolution;
}

async function qualifySessionAttachmentTeamInTx(
    tx: Tx,
    input: Parameters<typeof qualifySessionTeamAuthenticationInTx>[1],
): Promise<SessionAccessGrantErrorCode | null> {
    const qualification = await qualifySessionTeamAuthenticationInTx(tx, input);
    if (qualification.status === "satisfied") return null;
    return projectMutationAdmissionError(
        qualification.status === "authentication_required" ? "authentication_required" : "authentication_unavailable",
    );
}

async function validateSessionContextTeamInTx(
    tx: Tx,
    params: Readonly<{
        actorAccountId: string;
        teamId: string;
        authentication: SessionAccessAuthentication;
    }>,
) {
    const team = await tx.team.findUnique({
        where: { id: params.teamId },
        select: { id: true, authenticationPolicy: true, sessionCreationPolicy: true },
    });
    if (!team) return { ok: false, error: "session_access_subject_not_found" } as const;
    const membership = await tx.teamMembership.findUnique({
        where: {
            teamId_accountId: { teamId: team.id, accountId: params.actorAccountId },
            ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE,
        },
        select: { id: true },
    });
    if (!membership) return { ok: false, error: "session_access_subject_ineligible" } as const;
    const error = await qualifySessionAttachmentTeamInTx(tx, {
        accountId: params.actorAccountId, team, authentication: params.authentication,
    });
    if (error) return { ok: false, error } as const;
    return { ok: true, team } as const;
}

type InitialSessionAccessInput = Readonly<{
    creatorAccountId: string;
    sessionId: string;
    initialAccess: SessionInitialAccessMaterializedV1;
    authentication: SessionAccessAuthentication;
    /** Supplied by the Layout-1 constructor for a row it just inserted. */
    newborn?: Readonly<{ validatedAudience?: readonly string[] }>;
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
    primaryTeam: Readonly<{ id: string; sessionCreationPolicy: TeamSessionCreationPolicy }> | null;
    resolved: readonly Readonly<{
        subject: ShareSubject;
        grant: SessionAccessGrantValue;
        accountEnvelopeInput?: unknown;
    }>[];
    envelopeWrites: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
}> | Readonly<{ ok: false; error: SessionAccessGrantErrorCode | "session_initial_access_creator_mismatch" }>;

/** Final creation admission. Materialization consumes these facts without a later permission read. */
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

    let primaryTeam: Extract<InitialSessionAccessAdmission, { ok: true }>["primaryTeam"] = null;
    if (session.primaryTeamId !== null) {
        const admission = await validateSessionContextTeamInTx(tx, {
            actorAccountId: params.creatorAccountId,
            teamId: session.primaryTeamId,
            authentication: params.authentication,
        });
        if (!admission.ok) return admission;
        primaryTeam = admission.team;
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
            authentication: params.authentication,
            admittedPrimaryTeamId: primaryTeam?.id,
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
    const primaryTeamGrant = resolved.find(
        (item) => item.subject.kind === "team" && item.subject.teamId === session.primaryTeamId,
    );
    if (primaryTeam?.sessionCreationPolicy === TeamSessionCreationPolicy.team_required) {
        if (!primaryTeamGrant) {
            resolved.push({
                subject: { kind: "team", teamId: primaryTeam.id },
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
            qualifiedTeamId: primaryTeam?.id,
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
    // A Team policy change after admission applies to the next birth. If its
    // newly required floor is absent here, the owner can share this Session or
    // the next Team policy apply supplies it; do not replay admitted work.

    // A private creation with no requested grants has no access transition to
    // publish. In particular, do not invalidate the owner's roster merely
    // because the owner is implicitly readable/manageable.
    if (resolved.length === 0) return { ok: true, effects: EMPTY_EFFECTS, directShares: [] };

    const validatedAudience = params.newborn?.validatedAudience;
    const affected = new Set(validatedAudience);
    if (!validatedAudience) {
        for (const { subject } of resolved) {
            for (const accountId of await resolveAffectedAccountIdsInTx(tx, subject)) affected.add(accountId);
        }
    }
    affected.delete(session.accountId);
    const previous = params.newborn ? null : await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId, accountIds: [...affected],
    });
    const effectiveAt = resolved.some(item => item.subject.kind !== "account")
        ? await readTransactionDatabaseTime(tx) : undefined;
    const directShares: SessionAccessDirectShareRow[] = [];
    for (const item of resolved) {
        if (item.subject.kind === "account") {
            directShares.push(projectDirectSessionGrant(await tx.sessionGrant.create({
                data: { principalKind: 'account',
                    sessionId: params.sessionId,
                    createdByAccountId: params.creatorAccountId,
                    accountId: item.subject.accountId,
                    accessLevel: item.grant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: item.grant.canApprovePermissions,
                },
            })));
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
            await tx.sessionGrant.create({
                data: { principalKind: 'team', createdByAccountId: params.creatorAccountId,
                    sessionId: params.sessionId,
                    teamId: item.subject.teamId,
                    accessLevel: item.grant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: item.grant.canApprovePermissions,
                    requiredByTeamPolicy: primaryTeam?.sessionCreationPolicy === TeamSessionCreationPolicy.team_required && item.subject.teamId === session.primaryTeamId,
                    effectiveAt,
                },
            });
        } else {
            await tx.sessionGrant.create({
                data: { principalKind: 'group', createdByAccountId: params.creatorAccountId,
                    sessionId: params.sessionId,
                    teamGroupId: item.subject.groupId,
                    accessLevel: item.grant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: item.grant.canApprovePermissions,
                    effectiveAt,
                },
            });
        }
    }
    if (validatedAudience) {
        // Use the existing effects fence to capture any recipients that joined
        // after the birth census. It replays before publication for new Accounts.
        const currentAudience = await acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId],
            [session.accountId, ...affected]);
        for (const accountId of currentAudience) {
            if (accountId !== session.accountId) affected.add(accountId);
        }
    }
    const after = await resolveStructuralSessionAccessForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: params.newborn ? [...affected, session.accountId] : [...affected],
    });
    const effects = await applyGrantTransitionEffectsInTx(tx, {
        sessionId: params.sessionId,
        actorAccountId: params.creatorAccountId,
        sessionOwnerAccountId: session.accountId,
        before: previous ?? new Map([...affected].map(accountId => [accountId, null] as const)),
        after,
        currentRosterAccess: params.newborn ? after : undefined,
        ...(validatedAudience ? { audienceFenced: true as const } : {}),
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
        const share = await tx.sessionGrant.findUnique({
            where: { principalKind: 'account',
                sessionId_accountId: { sessionId, accountId: subject.accountId },
            },
        });
        if (!share) return { stored: null, directShare: null };
        return {
            stored: {
                accessLevel: share.accessLevel,
                canApprovePermissions: share.canApprovePermissions,
                requiredByTeamPolicy: false,
            },
            directShare: projectDirectSessionGrant(share),
        };
    }
    if (subject.kind === "team") {
        const grant = await tx.sessionGrant.findUnique({
            where: { principalKind: 'team', sessionId_teamId: { sessionId, teamId: subject.teamId } },
            select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
        });
        return { stored: grant ?? null, directShare: null };
    }
    const grant = await tx.sessionGrant.findUnique({
        where: { principalKind: 'group', sessionId_teamGroupId: { sessionId, teamGroupId: subject.groupId } },
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
    options?: Readonly<{ includeInactiveAccounts?: boolean }>,
): Promise<string[]> {
    if (subject.kind === "account") return [subject.accountId];
    return await resolveSubjectMemberAccountIdsInTx(
        tx,
        subject.kind === "team"
            ? { kind: "team", teamId: subject.teamId }
            : { kind: "group", teamId: subject.teamId, groupId: subject.groupId },
        options,
    );
}

/** Admit retained members before the grant exists so reactivation waits behind the same fence. */
export async function readInitialSessionAccessFenceAccountIdsInTx(tx: Tx, input: Readonly<{
    initialAccess?: SessionInitialAccessMaterializedV1;
    primaryTeamId?: string | null;
}>): Promise<readonly string[]> {
    const subjects = (input.initialAccess?.grants ?? []).map(grant => grant.subject);
    const primaryTeamId = input.primaryTeamId;
    const hasExplicitPrimaryTeam = subjects.some(subject => subject.kind === "team" && subject.teamId === primaryTeamId);
    const addRequiredPrimaryTeam = !!primaryTeamId && !hasExplicitPrimaryTeam && await teamPolicyStillRequiresGrant(tx, primaryTeamId);
    if (addRequiredPrimaryTeam) subjects.push({ kind: "team", teamId: primaryTeamId });
    const accounts = new Set<string>();
    for (const subject of subjects) {
        for (const accountId of await resolveAffectedAccountIdsInTx(tx, subject, { includeInactiveAccounts: true })) accounts.add(accountId);
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
        currentRosterAccess?: ReadonlyMap<string, EffectiveSessionAccess | null>;
        audienceFenced?: true;
    }>,
): Promise<SessionAccessGrantEffects> {
    const rosterManagerAccountIds = new Set<string>();
    const currentAccess = params.currentRosterAccess ?? await resolveStructuralSessionAccessForAccountsInTx(tx, {
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
        authentication: params.authentication,
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
        directShare = projectDirectSessionGrant(await tx.sessionGrant.upsert({
            where: { principalKind: 'account',
                sessionId_accountId: {
                    sessionId: params.sessionId,
                    accountId: subject.accountId,
                },
            },
            create: { principalKind: 'account',
                sessionId: params.sessionId,
                createdByAccountId: params.actorAccountId,
                accountId: subject.accountId,
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
            },
            update: {
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
            },
        }));
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
            await tx.sessionGrant.create({
                data: { principalKind: 'team', createdByAccountId: params.actorAccountId,
                    sessionId: params.sessionId,
                    teamId: subject.teamId,
                    accessLevel: value.accessLevel as ShareAccessLevel,
                    canApprovePermissions: value.canApprovePermissions,
                    requiredByTeamPolicy,
                    effectiveAt: await readTransactionDatabaseTime(tx),
                },
            });
        } else {
            await tx.sessionGrant.update({
                where: { principalKind: 'team', sessionId_teamId: { sessionId: params.sessionId, teamId: subject.teamId } },
                data: {
                    accessLevel: value.accessLevel as ShareAccessLevel,
                    canApprovePermissions: value.canApprovePermissions,
                    requiredByTeamPolicy,
                },
            });
        }
    } else if (stored === null) {
        await tx.sessionGrant.create({
            data: { principalKind: 'group', createdByAccountId: params.actorAccountId,
                sessionId: params.sessionId,
                teamGroupId: subject.groupId,
                accessLevel: value.accessLevel as ShareAccessLevel,
                canApprovePermissions: value.canApprovePermissions,
                effectiveAt: await readTransactionDatabaseTime(tx),
            },
        });
    } else {
        await tx.sessionGrant.update({
            where: { principalKind: 'group',
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
        authentication: params.authentication,
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
        await tx.sessionGrant.delete({
            where: { principalKind: 'account',
                sessionId_accountId: {
                    sessionId: params.sessionId,
                    accountId: subject.accountId,
                },
            },
        });
    } else if (subject.kind === "team") {
        await tx.sessionGrant.delete({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: params.sessionId, teamId: subject.teamId } },
        });
    } else {
        await tx.sessionGrant.delete({
            where: { principalKind: 'group',
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

    const markerState = await tx.sessionGrant.findMany({
        where: { principalKind: 'team', sessionId: params.sessionId, requiredByTeamPolicy: true },
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
        const admission = await validateSessionContextTeamInTx(tx, {
            actorAccountId: params.actorAccountId,
            teamId: params.primaryTeamId,
            authentication: params.authentication,
        });
        if (!admission.ok) return admission;

        targetTeamRequired = admission.team.sessionCreationPolicy === TeamSessionCreationPolicy.team_required;
        if (targetTeamRequired) {
            targetTeamGrant = await tx.sessionGrant.findUnique({
                where: { principalKind: 'team', sessionId_teamId: { sessionId: params.sessionId, teamId: params.primaryTeamId } },
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
            qualifiedTeamId: params.primaryTeamId ?? undefined,
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
    const readResult = async (): Promise<SetSessionAccessContextResult> => {
        const rows = await tx.sessionGrant.findMany({
            where: { sessionId: params.sessionId, principalKind: "team" },
            select: { team: { select: { id: true, name: true } }, accessLevel: true },
            orderBy: { teamId: "asc" },
        });
        return {
            ok: true,
            changed,
            primaryTeamId: params.primaryTeamId,
            teamGrants: rows.flatMap(({ team, accessLevel }) => team
                ? [{ teamId: team.id, name: team.name, accessLevel }]
                : []),
        };
    };
    if (!changed) return await readResult();

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
    await tx.sessionGrant.updateMany({
        where: { principalKind: 'team',
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
            await tx.sessionGrant.create({
                data: { principalKind: 'team', createdByAccountId: params.actorAccountId,
                    ...key,
                    accessLevel: requiredGrant.accessLevel as ShareAccessLevel,
                    canApprovePermissions: requiredGrant.canApprovePermissions,
                    requiredByTeamPolicy: true,
                    effectiveAt: await readTransactionDatabaseTime(tx),
                },
            });
        } else {
            await tx.sessionGrant.update({
                where: { principalKind: 'team', sessionId_teamId: key },
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
    return await readResult();
}

/**
 * Entry discovery and cleanup share the retained-share predicate: direct grants
 * this Account received, and grants of every principal kind it authored.
 */
export async function readSessionAccessGrantsForAccountErasureInTx(tx: Tx, accountId: string) {
    const shares = await tx.sessionGrant.findMany({
        where: {
            OR: [{ createdByAccountId: accountId }, { principalKind: 'account', accountId: accountId }],
        },
        select: {
            id: true,
            sessionId: true,
            principalKind: true,
            accountId: true,
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
 * The creator column is provenance with a RESTRICT Account FK, so each retained
 * grant (direct, Team or Group) moves to its own Session owner without changing
 * access or key material.
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
        if (share.principalKind !== 'account') {
            // Reassigning a Team or Group grant's creator changes no one's access.
            await tx.sessionGrant.update({
                where: { id: share.id },
                data: { createdByAccountId: share.session.accountId },
            });
            continue;
        }
        const sharedWithUserId = share.accountId!;
        const accountIds = [sharedWithUserId];
        const before = await resolveStructuralSessionAccessForAccountsInTx(tx, {
            sessionId: share.sessionId,
            accountIds,
        });
        if (sharedWithUserId === params.accountId) {
            await tx.sessionGrant.delete({ where: { principalKind: 'account', id: share.id } });
        } else {
            await tx.sessionGrant.update({
                where: { principalKind: 'account', id: share.id },
                data: { createdByAccountId: share.session.accountId },
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
            directGrantChangedAccountId: sharedWithUserId,
        });
    }
}
