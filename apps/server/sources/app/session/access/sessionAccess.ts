import { db } from "@/storage/db";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import type { Prisma } from "@prisma/client";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { isSessionTranscriptShareable, SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { buildSessionReadableAccountWhereInTx } from "./sessionAccessWhere";
import type { SessionCollectiveAccessSnapshot } from "./sessionAccessWhere";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { mayInjectSessionContextInTx } from './sessionContextInjection';
import {
    qualifySessionTeamAuthenticationInTx,
    qualifySessionTeamAuthenticationsInTx,
    resolveQualifiedSessionTeamIdsInTx,
    type SessionAccessAuthentication,
} from "./sessionAccessAuthentication";

import { SESSION_CAPABILITY_RULES, SESSION_ACCESS_LEVEL_ORDER, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import type { EffectiveSessionAccessLevelV1, SessionCapabilityV1, SessionAccessSourceV1, SessionEffectiveAccessV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { evaluateApiTokenGrantV1, resolveApiTokenSessionCapabilityCeilingV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
export { SESSION_CAPABILITY_RULES, SESSION_ACCESS_LEVEL_ORDER };
export type SessionAccessLevel = EffectiveSessionAccessLevelV1;
export type SessionCapability = SessionCapabilityV1;
export type SessionAccessSource = SessionAccessSourceV1;
export interface EffectiveSessionAccess {
    readonly accountId: string;
    readonly sessionId: string;
    readonly level: SessionAccessLevel;
    readonly sources: readonly SessionAccessSource[];
    readonly audienceContext: SessionEffectiveAccessV1['audienceContext'];
    readonly primaryTeamId?: string | null;
    /** All applicable relationships for private Follow preferences, not grant authority. */
    readonly relationshipKinds: readonly ("direct" | "team" | "group")[];
    readonly capabilities: Readonly<Record<SessionCapability, boolean>>;
}
/** The transport projection excludes server-only Account and Session identity. */
export function projectSessionEffectiveAccessV1(access: EffectiveSessionAccess): SessionEffectiveAccessV1 {
    return { v: 1, level: access.level, sources: [...access.sources], capabilities: { ...access.capabilities },
        audienceContext: access.audienceContext,
        ...(access.primaryTeamId !== undefined ? { primaryTeamId: access.primaryTeamId } : {}),
    };
}
export type SessionAccessReader = Pick<Tx, "session">;
// Session-major projections stay below the existing conservative SQLite bind boundary.
export const SESSION_ACCESS_SESSION_BATCH_SIZE = 200;
/**
 * Team and Group access, responsibility and atomic initial access are Session
 * sharing: they are served wherever `sharing.session` is enabled, with no
 * separate server-only collaboration switch. Direct Account shares stay
 * effective either way, so 0.2-created shares remain readable.
 */
export function isSessionCollaborationEnabled(): boolean {
    return isServerFeatureEnabledForRequest("sharing.session", process.env);
}

/** Lane 01 owns minting the cutoff; this owner alone interprets it. */
export function isGrantAfterMembershipHorizon(effectiveAt: Date, startsAt: Date | null): boolean {
    return startsAt === null || effectiveAt.getTime() > startsAt.getTime();
}

export function buildCurrentSessionAccessMembershipWhere(includeGuests: boolean): Prisma.TeamMembershipWhereInput {
    return {
        status: "active", account: { status: "active" },
        ...(includeGuests ? {} : { role: { not: "guest" as const } }),
    };
}

export function buildSessionAccessMembershipWhere(accountIds: readonly string[], includeGuests: boolean): Prisma.TeamMembershipWhereInput {
    return {
        ...buildCurrentSessionAccessMembershipWhere(includeGuests),
        accountId: { in: [...accountIds] },
    };
}

export interface SessionAccessProjectionContext {
    readonly mode?: "effective_access_v1" | "legacy_owner_or_direct";
    /** Membership facts captured by the access owner in this same read snapshot. */
    readonly collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
}

export function buildSessionAccessProjectionSelectForAccounts(accountIds: readonly string[], context: SessionAccessProjectionContext = {}) {
    const snapshot = context.collectiveAccessSnapshot;
    if (snapshot && (accountIds.length !== 1 || snapshot.accountId !== accountIds[0])) {
        throw new Error("Session access projection snapshot belongs to another Account");
    }
    const membershipIdentity = snapshot ? { id: { in: snapshot.memberships.map(membership => membership.id) } } : {};
    const teamMembership = { ...buildSessionAccessMembershipWhere(accountIds, false), ...membershipIdentity };
    const groupMembership = { teamMembership: { ...buildSessionAccessMembershipWhere(accountIds, true), ...membershipIdentity } };
    const collectiveEnabled = context.mode !== "legacy_owner_or_direct" && isSessionCollaborationEnabled();
    const teamIds = !collectiveEnabled ? [] : snapshot
        ? [...new Set(snapshot.memberships.filter(membership => membership.role !== "guest").map(membership => membership.teamId))]
        : undefined;
    const groupIds = !collectiveEnabled ? [] : snapshot
        ? [...new Set(snapshot.memberships.flatMap(membership => membership.groupMemberships.map(group => group.teamGroupId)))]
        : undefined;
    return {
        id: true,
        primaryTeamId: true,
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        account: { select: { status: true } },
        shares: { where: { sharedWithUserId: { in: [...accountIds] }, sharedWithUser: { status: "active" } }, select: { id: true, sharedWithUserId: true, accessLevel: true, canApprovePermissions: true } },
        teamGrants: {
            // Reuse the list's already-captured membership audience. Repeating
            // its inverse EXISTS here lets sparse grant tables drive a nested
            // Team/membership/Account scan for every Session. The nested select
            // retains exact membership identity, status and horizon facts.
            where: { ...(teamIds ? { teamId: { in: teamIds } } : {}), team: { archivedAt: null,
                ...(snapshot || !collectiveEnabled ? {} : { memberships: { some: teamMembership } }) } },
            select: {
                teamId: true, effectiveAt: true, accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true,
                team: { select: { authenticationPolicy: true, memberships: { where: teamMembership, select: { accountId: true, sessionAccessStartsAt: true } } } },
            },
        },
        groupGrants: {
            where: { ...(groupIds ? { teamGroupId: { in: groupIds } } : {}), teamGroup: { archivedAt: null, team: { archivedAt: null },
                ...(snapshot || !collectiveEnabled ? {} : { memberships: { some: groupMembership } }) } },
            select: {
                teamGroupId: true, effectiveAt: true, accessLevel: true, canApprovePermissions: true,
                teamGroup: { select: { teamId: true, team: { select: { authenticationPolicy: true } }, memberships: {
                    where: groupMembership, select: { sessionAccessStartsAt: true, teamMembership: { select: { accountId: true } } },
                } } },
            },
        },
    } as const satisfies Prisma.SessionSelect;
}
export function buildSessionAccessProjectionSelect(accountId: string, context: SessionAccessProjectionContext = {}) {
    return buildSessionAccessProjectionSelectForAccounts([accountId], context);
}
export type SessionAccessProjectionRow = Prisma.SessionGetPayload<{ select: ReturnType<typeof buildSessionAccessProjectionSelect> }>;

export interface ApplicableSessionGrant {
    readonly source: SessionAccessSource;
    readonly accessLevel: Exclude<SessionAccessLevel, "owner">;
    readonly canApprovePermissions: boolean;
}

function sourceKey(source: SessionAccessSource): string {
    if (source.kind === "direct") return `direct:${source.shareId}`;
    if (source.kind === "team") return `team:${source.teamId}`;
    if (source.kind === "group") return `group:${source.teamId}:${source.groupId}`;
    return "owner";
}

/** Same-grant capability rules prevent combining Admin and delegated Edit into escalation. */
function projectApplicableSessionGrants(accountId: string, sessionId: string, owner: boolean, grants: readonly ApplicableSessionGrant[]): EffectiveSessionAccess | null {
    if (!owner && grants.length === 0) return null;
    const ordered = [...grants].sort((left, right) =>
        SESSION_ACCESS_LEVEL_ORDER.indexOf(right.accessLevel) - SESSION_ACCESS_LEVEL_ORDER.indexOf(left.accessLevel)
        || sourceKey(left.source).localeCompare(sourceKey(right.source)));
    const level = owner ? "owner" : ordered[0].accessLevel;
    const capabilities = projectSessionAccessCapabilitiesV1({ owner, grants });
    const sources = new Map<string, SessionAccessSource>();
    const addSource = (grant: ApplicableSessionGrant | undefined) => { if (grant) sources.set(sourceKey(grant.source), grant.source); };
    if (!owner) {
        addSource(ordered[0]);
        addSource(ordered.find(grant => grant.accessLevel !== "view" && grant.canApprovePermissions));
        addSource(ordered.find(grant => grant.source.kind === "team" && grant.source.requiredByTeamPolicy));
    }
    const relationshipKinds = (["direct", "team", "group"] as const).filter(kind => grants.some(grant => grant.source.kind === kind));
    // Context is independent of strongest-level explanations. Exact Group wins
    // over Team, with immutable ids deciding presentation ties only (07.3 §9).
    const audienceSource = grants.map(grant => grant.source)
        .filter(source => source.kind === "group" || source.kind === "team")
        .sort((left, right) => sourceKey(left).localeCompare(sourceKey(right)))[0];
    const audienceContext = audienceSource?.kind === "group"
        ? { kind: "group" as const, teamId: audienceSource.teamId, groupId: audienceSource.groupId }
        : audienceSource?.kind === "team" ? { kind: "team" as const, teamId: audienceSource.teamId } : null;
    return { accountId, sessionId, level, relationshipKinds, audienceContext, sources: owner ? [{ kind: "owner" }] : [...sources.values()], capabilities };
}

/** Project only applicable current grants; keys and activity are not access facts. */
export function projectEffectiveSessionAccess(
    row: SessionAccessProjectionRow,
    accountId: string,
    options: Readonly<{
        mode?: "effective_access_v1" | "legacy_owner_or_direct";
        qualifiedTeamIds?: ReadonlySet<string>;
        /** Structural projection only; never use this result to authorize content or effects. */
        includeCredentialRestrictedTeamEntitlements?: boolean;
    }> = {},
): EffectiveSessionAccess | null {
    const owner = row.accountId === accountId;
    if (owner && !isActiveHomeAccountStatus(row.account.status)) return null;
    if (!owner && !isSessionTranscriptShareable(row)) return null;
    const grants: ApplicableSessionGrant[] = row.shares.filter(grant => grant.sharedWithUserId === accountId).map(grant => ({
        source: { kind: "direct", shareId: grant.id }, accessLevel: grant.accessLevel, canApprovePermissions: grant.canApprovePermissions,
    }));
    for (const grant of options.mode === "legacy_owner_or_direct" ? [] : row.teamGrants) {
        if (!options.includeCredentialRestrictedTeamEntitlements
            && !options.qualifiedTeamIds?.has(grant.teamId)) continue;
        const membership = grant.team.memberships.find(value => value.accountId === accountId);
        if (!membership || !isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) continue;
        grants.push({ source: { kind: "team", teamId: grant.teamId, requiredByTeamPolicy: grant.requiredByTeamPolicy }, accessLevel: grant.accessLevel, canApprovePermissions: grant.canApprovePermissions });
    }
    for (const grant of options.mode === "legacy_owner_or_direct" ? [] : row.groupGrants) {
        if (!options.includeCredentialRestrictedTeamEntitlements
            && !options.qualifiedTeamIds?.has(grant.teamGroup.teamId)) continue;
        const membership = grant.teamGroup.memberships.find(value => value.teamMembership.accountId === accountId);
        if (!membership || !isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) continue;
        grants.push({ source: { kind: "group", teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId }, accessLevel: grant.accessLevel, canApprovePermissions: grant.canApprovePermissions });
    }
    const access = projectApplicableSessionGrants(accountId, row.id, owner, grants);
    // Authored context is safe display context for every authorized reader. It is
    // not audience authority and may name a Team unrelated to the decisive grant.
    return access ? { ...access, primaryTeamId: row.primaryTeamId ?? null } : null;
}

export type SessionAccessOperationDecision =
    | Readonly<{ status: "allowed"; access: EffectiveSessionAccess }>
    | Readonly<{ status: "authentication_required" }>
    | Readonly<{ status: "authentication_unavailable" }>
    | Readonly<{ status: "unavailable" }>;

function projectIndependentSessionAccess(row: SessionAccessProjectionRow, accountId: string): EffectiveSessionAccess | null {
    const independentRow = {
        ...row,
        teamGrants: [],
        groupGrants: [],
    };
    return projectEffectiveSessionAccess(independentRow, accountId);
}

function projectExactSessionRuntimeAccess(
    row: SessionAccessProjectionRow,
    accountId: string,
    authentication: SessionAccessAuthentication,
): EffectiveSessionAccess | null {
    const principal = authentication.sessionRuntimePrincipal;
    if (!principal) return null;
    if (
        principal.accountId !== accountId
        || principal.sessionId !== row.id
        || row.accountId !== principal.accountId
        || !isActiveHomeAccountStatus(row.account.status)
    ) {
        return null;
    }
    return {
        accountId,
        sessionId: row.id,
        level: "edit",
        capabilities: projectSessionAccessCapabilitiesV1({
            owner: false,
            grants: [{ accessLevel: "edit", canApprovePermissions: false }],
        }),
        // Runtime authority is credential-derived, not a persisted sharing relationship.
        sources: [],
        relationshipKinds: [],
        audienceContext: null,
        primaryTeamId: row.primaryTeamId ?? null,
    };
}

/**
 * Credential-qualified protected-operation decision. Structural entitlement and Team
 * authentication remain separate until this single composition point; owner/direct OR
 * paths therefore cannot be suppressed by a failing Team-derived path.
 */
export async function resolveSessionAccessForOperation(
    reader: Tx,
    input: Readonly<{
        accountId: string;
        sessionId: string;
        authentication: SessionAccessAuthentication;
        /**
         * When present, preserve the authentication continuation for the exact
         * requested capability. A weaker independent grant may keep ordinary
         * reads available while a restricted Team grant is the only source that
         * can satisfy this operation.
         */
        capability?: SessionCapability;
        /** A declared direct-token operation is admitted independently of its coarse UI ceiling. */
        apiTokenAction?: Readonly<{ actionId: ActionId; targetMachineId?: string | null }>;
        /**
         * Which seam projection the caller is answering. `legacy_owner_or_direct`
         * leaves Team and Group grants out of the answer for a released reader;
         * every other rule — runtime-principal currentness, Account status,
         * transcript shareability, capability — stays here, so the two seam
         * projections cannot drift into two access decisions.
         */
        accessMode?: "effective_access_v1" | "legacy_owner_or_direct";
        /**
         * The canonical access projection the caller already loaded for this
         * exact Session, so a released reader still pays for one row read.
         */
        row?: SessionAccessProjectionRow;
    }>,
): Promise<SessionAccessOperationDecision> {
    return resolveSessionAccessForOperationWithTeamQualifications(reader, input);
}

/** Batch callers carry same-snapshot qualification facts; every access decision stays here. */
async function resolveSessionAccessForOperationWithTeamQualifications(
    reader: Tx,
    input: Parameters<typeof resolveSessionAccessForOperation>[1],
    teamQualifications?: Awaited<ReturnType<typeof qualifySessionTeamAuthenticationsInTx>>,
): Promise<SessionAccessOperationDecision> {
    const grant = input.authentication.apiTokenGrant;
    const exactTokenAction = grant && input.apiTokenAction;
    if (grant && exactTokenAction && !evaluateApiTokenGrantV1({
        grant, actionId: exactTokenAction.actionId,
        target: { kind: "session", sessionId: input.sessionId },
        targetMachineId: exactTokenAction.targetMachineId,
    }).ok) return { status: "unavailable" };
    const admitAccess = async (resolved: EffectiveSessionAccess): Promise<SessionAccessOperationDecision> => {
        let access = resolved;
        if (input.authentication.apiTokenGrant) {
            const ceiling = new Set<string>(resolveApiTokenSessionCapabilityCeilingV1(input.authentication.apiTokenGrant));
            const capabilities = { ...resolved.capabilities };
            for (const capability of Object.keys(capabilities) as SessionCapability[]) {
                capabilities[capability] = capabilities[capability] && ceiling.has(capability);
            }
            access = { ...resolved, capabilities };
        }
        // Exact Action admission still requires the underlying Account/share
        // capability; the capped projection continues to describe the UI surface.
        if (input.capability !== undefined && !(exactTokenAction ? resolved : access).capabilities[input.capability]) {
            return { status: 'unavailable' };
        }
        const destinationSessionId = input.authentication.contentDisclosureSessionId;
        if (input.capability === 'readTranscript' && destinationSessionId && destinationSessionId !== input.sessionId) {
            // Read admission, including the post-snapshot fence, observes the
            // complete current destination audience. Pairwise projections do
            // not request a content capability and therefore do not recurse.
            const disclosure = await mayInjectSessionContextInTx(reader, { configuringAccountId: input.accountId,
                sourceSessionId: input.sessionId, destinationSessionId, authentication: input.authentication });
            if (!disclosure.ok) return { status: 'unavailable' };
        }
        return { status: 'allowed', access };
    };
    const runtimePrincipal = input.authentication.sessionRuntimePrincipal;
    if (
        runtimePrincipal
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(reader, runtimePrincipal)
    ) {
        return { status: "unavailable" };
    }
    const row = input.row ?? await reader.session.findUnique({
        where: { id: input.sessionId },
        select: buildSessionAccessProjectionSelect(input.accountId),
    });
    // A supplied row that names another Session fails closed instead of
    // authorizing it; the decision below reads the row, not the requested id.
    if (!row || row.id !== input.sessionId) return { status: "unavailable" };

    if (runtimePrincipal) {
        const access = projectExactSessionRuntimeAccess(row, input.accountId, input.authentication);
        if (!access) return { status: "unavailable" };
        return admitAccess(access);
    }

    if (input.accessMode === "legacy_owner_or_direct") {
        // Released seam projection. Collective entitlement is not merely
        // unqualified here, it is absent from the answer, so an old reader can
        // never receive Team- or Group-derived access or a Team-derived
        // authentication continuation.
        const released = projectIndependentSessionAccess(row, input.accountId);
        if (!released) return { status: "unavailable" };
        return admitAccess(released);
    }

    const independent = projectIndependentSessionAccess(row, input.accountId);
    // Ownership is already the strongest possible answer. A direct grant is not:
    // it must be combined with any credential-qualified collective grants so a
    // direct View row cannot mask an applicable Team Edit/Admin row.
    if (independent?.level === "owner") return admitAccess(independent);
    if (!isSessionTranscriptShareable(row)) return { status: "unavailable" };

    const grants: ApplicableSessionGrant[] = row.shares
        .filter(grant => grant.sharedWithUserId === input.accountId)
        .map(grant => ({
            source: { kind: "direct" as const, shareId: grant.id },
            accessLevel: grant.accessLevel,
            canApprovePermissions: grant.canApprovePermissions,
        }));
    let sawAuthenticationRequired = false;
    let sawAuthenticationUnavailable = false;
    let sawCollectiveEntitlement = false;
    const qualificationByTeamId = new Map<string, Awaited<ReturnType<typeof qualifySessionTeamAuthenticationInTx>>>();
    const qualifyTeam = async (team: Readonly<{ id: string; authenticationPolicy: unknown }>) => {
        if (teamQualifications) return teamQualifications.get(team.id) ?? { status: 'unavailable' as const };
        const existing = qualificationByTeamId.get(team.id);
        if (existing) return existing;
        const qualification = await qualifySessionTeamAuthenticationInTx(reader, {
            accountId: input.accountId,
            team,
            authentication: input.authentication,
        });
        qualificationByTeamId.set(team.id, qualification);
        return qualification;
    };

    const grantCanSupplyRequestedCapability = (grant: ApplicableSessionGrant): boolean =>
        input.capability === undefined
        || projectSessionAccessCapabilitiesV1({ owner: false, grants: [grant] })[input.capability];

    const recordUnsatisfiedQualification = (
        grant: ApplicableSessionGrant,
        qualification: Awaited<ReturnType<typeof qualifySessionTeamAuthenticationInTx>>,
    ): void => {
        if (!grantCanSupplyRequestedCapability(grant)) return;
        if (qualification.status === "authentication_required") sawAuthenticationRequired = true;
        if (qualification.status === "unavailable") sawAuthenticationUnavailable = true;
    };

    for (const grant of row.teamGrants) {
        const membership = grant.team.memberships.find(value => value.accountId === input.accountId);
        if (!membership || !isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) continue;
        sawCollectiveEntitlement = true;
        const applicableGrant: ApplicableSessionGrant = {
            source: { kind: "team", teamId: grant.teamId, requiredByTeamPolicy: grant.requiredByTeamPolicy },
            accessLevel: grant.accessLevel,
            canApprovePermissions: grant.canApprovePermissions,
        };
        const qualification = await qualifyTeam({ id: grant.teamId, authenticationPolicy: grant.team.authenticationPolicy });
        if (qualification.status !== "satisfied") {
            recordUnsatisfiedQualification(applicableGrant, qualification);
            continue;
        }
        grants.push(applicableGrant);
    }
    for (const grant of row.groupGrants) {
        const membership = grant.teamGroup.memberships.find(value => value.teamMembership.accountId === input.accountId);
        if (!membership || !isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) continue;
        sawCollectiveEntitlement = true;
        const applicableGrant: ApplicableSessionGrant = {
            source: { kind: "group", teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId },
            accessLevel: grant.accessLevel,
            canApprovePermissions: grant.canApprovePermissions,
        };
        const qualification = await qualifyTeam({ id: grant.teamGroup.teamId, authenticationPolicy: grant.teamGroup.team.authenticationPolicy });
        if (qualification.status !== "satisfied") {
            recordUnsatisfiedQualification(applicableGrant, qualification);
            continue;
        }
        grants.push(applicableGrant);
    }
    const access = projectApplicableSessionGrants(input.accountId, row.id, false, grants);
    if (access && (input.capability === undefined || access.capabilities[input.capability])) {
        return admitAccess({ ...access, primaryTeamId: row.primaryTeamId ?? null });
    }
    if (sawAuthenticationRequired) return { status: "authentication_required" };
    if (sawAuthenticationUnavailable) return { status: "authentication_unavailable" };
    if (access && input.capability === undefined) return admitAccess({ ...access, primaryTeamId: row.primaryTeamId ?? null });
    return {
        status: input.capability === undefined && sawCollectiveEntitlement
            ? "authentication_unavailable"
            : "unavailable",
    };
}

/**
 * Re-admit a protected read after its content snapshot has closed. Snapshot
 * corpus admission stays with the supplied reader; this final decision must
 * observe revocations committed while that snapshot was being read.
 */
export async function readCurrentSessionAccessForOperation(
    input: Omit<Parameters<typeof resolveSessionAccessForOperation>[1], "row">,
): Promise<SessionAccessOperationDecision> {
    return await inReadSnapshot(reader => resolveSessionAccessForOperation(reader, {
        ...input,
        // Even a structurally wider caller cannot reuse an earlier access row.
        row: undefined,
    }));
}

/** Evidence-independent entitlement projection for internal census/preparation only. */
export async function resolveStructuralSessionAccess(reader: SessionAccessReader, input: { accountId: string; sessionId: string }): Promise<EffectiveSessionAccess | null> {
    const row = await reader.session.findUnique({ where: { id: input.sessionId }, select: buildSessionAccessProjectionSelect(input.accountId) });
    return row ? projectEffectiveSessionAccess(row, input.accountId, {
        includeCredentialRestrictedTeamEntitlements: true,
    }) : null;
}

/** Credential-aware protected-operation projection. */
export async function resolveEffectiveSessionAccess(reader: Tx, input: { accountId: string; sessionId: string; authentication: SessionAccessAuthentication }): Promise<EffectiveSessionAccess | null> {
    const decision = await resolveSessionAccessForOperation(reader, {
        ...input,
        authentication: input.authentication,
    });
    return decision.status === "allowed" ? decision.access : null;
}

/** Same-snapshot row decisions share Team qualification, never access policy or a later admission fence. */
export async function resolveSessionAccessForRowsInTx(reader: Tx, input: Omit<Parameters<typeof resolveSessionAccessForOperation>[1], 'sessionId' | 'row'>,
    rows: readonly SessionAccessProjectionRow[],
): Promise<ReadonlyMap<string, SessionAccessOperationDecision>> {
    const teams = input.authentication.sessionRuntimePrincipal || input.accessMode === 'legacy_owner_or_direct' ? [] : rows
        .filter(row => row.accountId !== input.accountId && isSessionTranscriptShareable(row))
        .flatMap(row => [
            ...row.teamGrants.map(grant => ({ id: grant.teamId, authenticationPolicy: grant.team.authenticationPolicy })),
            ...row.groupGrants.map(grant => ({ id: grant.teamGroup.teamId, authenticationPolicy: grant.teamGroup.team.authenticationPolicy })),
        ]);
    const teamQualifications = await qualifySessionTeamAuthenticationsInTx(reader, { ...input, teams });
    const result = new Map<string, SessionAccessOperationDecision>();
    for (const row of rows) result.set(row.id,
        await resolveSessionAccessForOperationWithTeamQualifications(reader, { ...input, sessionId: row.id, row }, teamQualifications));
    return result;
}

/** Batch row loading for one actor; every decision remains the exact operation resolver. */
export async function resolveEffectiveSessionAccessForSessionsInTx(reader: Tx, input: Readonly<{
    accountId: string; sessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, EffectiveSessionAccess>> {
    const result = new Map<string, EffectiveSessionAccess>();
    const sessionIds = [...new Set(input.sessionIds)];
    // This chunks database parameters, never the authorized result set.
    for (let offset = 0; offset < sessionIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const rows = await reader.session.findMany({
            where: { id: { in: sessionIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE) } },
            select: buildSessionAccessProjectionSelect(input.accountId),
        });
        for (const row of rows) {
            const decision = await resolveSessionAccessForOperation(reader, { ...input, sessionId: row.id, row });
            if (decision.status === "allowed") result.set(row.id, decision.access);
        }
    }
    return result;
}
export type SessionCapabilityAssertion =
    | { ok: true; access: EffectiveSessionAccess }
    | { ok: false; reason: "authentication_required" | "authentication_unavailable" | "unavailable" };
export async function assertSessionCapabilityInTx(input: {
    tx: Tx;
    accountId: string;
    sessionId: string;
    capability: SessionCapability;
    authentication: SessionAccessAuthentication;
}): Promise<SessionCapabilityAssertion> {
    const decision = await resolveSessionAccessForOperation(input.tx, {
        accountId: input.accountId,
        sessionId: input.sessionId,
        authentication: input.authentication,
        capability: input.capability,
    });
    if (decision.status !== "allowed") return { ok: false, reason: decision.status };
    const access = decision.access;
    return access?.capabilities[input.capability] ? { ok: true, access } : { ok: false, reason: "unavailable" };
}
/** Execution-custody operations stay owner-only independently of human capability names. */
export async function assertSessionOwnerInTx(input: {
    tx: SessionAccessReader; accountId: string; sessionId: string;
}): Promise<SessionCapabilityAssertion> {
    const access = await resolveStructuralSessionAccess(input.tx, input);
    return access?.level === "owner" ? { ok: true, access } : { ok: false, reason: "unavailable" };
}

/**
 * Team-resource visibility is the exact Team grant, independent of the requesting
 * Account's decisive sources or the Session's authored primary Team context.
 * Every grant level includes read access; per-Account membership and authentication
 * eligibility remain the ordinary access resolver's responsibility.
 */
export async function assertSessionTeamReadableGrantInTx(input: {
    tx: SessionAccessReader; sessionId: string; teamId: string;
}): Promise<{ ok: true } | { ok: false; reason: "unavailable" }> {
    if (!isSessionCollaborationEnabled()) return { ok: false, reason: "unavailable" };
    const session = await input.tx.session.findFirst({
        where: { AND: [
            { id: input.sessionId },
            { teamGrants: { some: { teamId: input.teamId, team: { archivedAt: null } } } },
        ] },
        select: SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    });
    return session && isSessionTranscriptShareable(session) ? { ok: true } : { ok: false, reason: "unavailable" };
}

/**
 * The set-oriented sibling of `resolveSessionAccessForOperation`: one Session,
 * many Accounts, one credential context.
 *
 * It reads the same projection row the per-Account decision reads — once per
 * bounded Account batch rather than once per Account — and projects it through
 * the same pure `projectEffectiveSessionAccess`, so admission, level and
 * capabilities are the per-Account answer. Team qualification is likewise taken
 * once for the credential context instead of once per recipient.
 *
 * The one deliberate difference is explanatory, not decisive: the per-operation
 * path answers an owner from an entitlement projection with Team and Group
 * grants stripped, so an owner who also holds a Team grant on their own Session
 * is described here with that Team in `relationshipKinds`/`audienceContext`.
 * Ownership already carries every capability, so the admission is identical.
 *
 * A Session runtime principal authorizes one exact Session for one exact
 * Account, so it is never a set; that caller keeps the per-Account decision.
 */
export async function resolveSessionAccessForAccountsInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    accountIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, EffectiveSessionAccess>> {
    const admitted = new Map<string, EffectiveSessionAccess>();
    const accountIds = [...new Set(input.accountIds)];
    if (accountIds.length === 0) return admitted;
    if (input.authentication.sessionRuntimePrincipal) {
        throw new Error("A Session runtime principal authorizes exactly one Account");
    }
    // Same conservative bind boundary as the structural reader below: this
    // chunks transport parameters, never the authorized result set.
    for (let offset = 0; offset < accountIds.length; offset += 100) {
        const batch = accountIds.slice(offset, offset + 100);
        const row = await tx.session.findUnique({
            where: { id: input.sessionId },
            select: buildSessionAccessProjectionSelectForAccounts(batch),
        });
        if (!row || row.id !== input.sessionId) continue;
        const qualifiedTeamIds = await resolveQualifiedSessionTeamIdsInTx(tx, {
            accountIds: batch,
            teams: [
                ...row.teamGrants.map(grant => ({ id: grant.teamId, authenticationPolicy: grant.team.authenticationPolicy })),
                ...row.groupGrants.map(grant => ({ id: grant.teamGroup.teamId, authenticationPolicy: grant.teamGroup.team.authenticationPolicy })),
            ],
            authentication: input.authentication,
        });
        for (const accountId of batch) {
            const access = projectEffectiveSessionAccess(row, accountId, { qualifiedTeamIds });
            if (access) admitted.set(accountId, access);
        }
    }
    return admitted;
}

/**
 * Session-major sibling of the qualified Account-set reader. Personal
 * attention pages already hold many Sessions; keep that path set-oriented
 * while using the exact same projection and Team qualification owner as the
 * single-Session reader above.
 */
export async function resolveSessionAccessForSessionsInTx(tx: Tx, input: Readonly<{
    sessionIds: readonly string[];
    accountIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, ReadonlyMap<string, EffectiveSessionAccess>>> {
    const result = new Map<string, Map<string, EffectiveSessionAccess>>();
    const sessionIds = [...new Set(input.sessionIds)];
    const accountIds = [...new Set(input.accountIds)];
    if (sessionIds.length === 0 || accountIds.length === 0) return result;
    if (input.authentication.sessionRuntimePrincipal) {
        throw new Error("A Session runtime principal authorizes exactly one Session");
    }
    for (let accountOffset = 0; accountOffset < accountIds.length; accountOffset += 100) {
        const accountBatch = accountIds.slice(accountOffset, accountOffset + 100);
        for (let sessionOffset = 0; sessionOffset < sessionIds.length; sessionOffset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const sessionBatch = sessionIds.slice(sessionOffset, sessionOffset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            const rows = await tx.session.findMany({
                where: { id: { in: sessionBatch } },
                select: buildSessionAccessProjectionSelectForAccounts(accountBatch),
            });
            const teams = rows.flatMap(row => [
                ...row.teamGrants.map(grant => ({ id: grant.teamId, authenticationPolicy: grant.team.authenticationPolicy })),
                ...row.groupGrants.map(grant => ({ id: grant.teamGroup.teamId, authenticationPolicy: grant.teamGroup.team.authenticationPolicy })),
            ]);
            const qualifiedTeamIds = await resolveQualifiedSessionTeamIdsInTx(tx, {
                accountIds: accountBatch,
                teams,
                authentication: input.authentication,
            });
            for (const row of rows) {
                const perAccount = result.get(row.id) ?? new Map<string, EffectiveSessionAccess>();
                for (const accountId of accountBatch) {
                    const access = projectEffectiveSessionAccess(row, accountId, { qualifiedTeamIds });
                    if (access) perAccount.set(accountId, access);
                }
                if (perAccount.size > 0) result.set(row.id, perAccount);
            }
        }
    }
    return result;
}

export async function resolveStructuralSessionAccessForAccountsInTx(tx: SessionAccessReader, input: {
    sessionId: string; accountIds: readonly string[];
}): Promise<ReadonlyMap<string, EffectiveSessionAccess | null>> {
    const result = new Map<string, EffectiveSessionAccess | null>();
    const accountIds = [...new Set(input.accountIds)];
    // The repeated Account filters remain below SQLite's conservative 999-bind
    // boundary. This chunks transport parameters, never the authorized result set.
    for (let offset = 0; offset < accountIds.length; offset += 100) {
        const batch = accountIds.slice(offset, offset + 100);
        const row = await tx.session.findUnique({ where: { id: input.sessionId }, select: buildSessionAccessProjectionSelectForAccounts(batch) });
        for (const accountId of batch) result.set(accountId, row ? projectEffectiveSessionAccess(row, accountId, {
            includeCredentialRestrictedTeamEntitlements: true,
        }) : null);
    }
    return result;
}

/**
 * The Session-major sibling of the reader above, for a caller holding a page of
 * Sessions rather than one.
 *
 * It projects the same grants through the same pure `projectEffectiveSessionAccess`,
 * so a batched caller cannot drift from the per-Session answer; the only
 * difference is that one `findMany` replaces one query per Session. Sessions are
 * chunked for the same conservative bind boundary as the Account batches above,
 * and a Session the reader cannot see is simply absent from the result.
 */
export async function resolveStructuralSessionAccessForSessionsInTx(tx: SessionAccessReader, input: {
    sessionIds: readonly string[]; accountIds: readonly string[];
}): Promise<ReadonlyMap<string, ReadonlyMap<string, EffectiveSessionAccess | null>>> {
    const result = new Map<string, Map<string, EffectiveSessionAccess | null>>();
    const accountIds = [...new Set(input.accountIds)];
    const sessionIds = [...new Set(input.sessionIds)];
    if (accountIds.length === 0 || sessionIds.length === 0) return result;
    for (let accountOffset = 0; accountOffset < accountIds.length; accountOffset += 100) {
        const accountBatch = accountIds.slice(accountOffset, accountOffset + 100);
        for (let sessionOffset = 0; sessionOffset < sessionIds.length; sessionOffset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const sessionBatch = sessionIds.slice(sessionOffset, sessionOffset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            const rows = await tx.session.findMany({
                where: { id: { in: sessionBatch } },
                select: buildSessionAccessProjectionSelectForAccounts(accountBatch),
            });
            for (const row of rows) {
                const perAccount = result.get(row.id) ?? new Map<string, EffectiveSessionAccess | null>();
                for (const accountId of accountBatch) perAccount.set(accountId, projectEffectiveSessionAccess(row, accountId, {
                    includeCredentialRestrictedTeamEntitlements: true,
                }));
                result.set(row.id, perAccount);
            }
        }
    }
    return result;
}

async function hasCapability(
    accountId: string,
    sessionId: string,
    capability: SessionCapability,
    authentication: SessionAccessAuthentication,
): Promise<boolean> {
    const access = await resolveSessionAccessForOperation(db, {
        accountId,
        sessionId,
        authentication,
        capability,
    });
    return access.status === "allowed" && access.access.capabilities[capability] === true;
}
export const canManageSharing = (accountId: string, sessionId: string, authentication: SessionAccessAuthentication) => hasCapability(accountId, sessionId, "manageAccess", authentication);
export const canApprovePermissions = (accountId: string, sessionId: string, authentication: SessionAccessAuthentication) => hasCapability(accountId, sessionId, "approveRuntimePermissions", authentication);
export const canManagePermissionDelegation = (accountId: string, sessionId: string, authentication: SessionAccessAuthentication) => hasCapability(accountId, sessionId, "managePermissionDelegation", authentication);

// Recipient expansion lives in `./sessionRecipients`, which also reaches Team and
// Group grants. An owner/direct-only copy here would silently drop those
// collaborators from every projection fanout that consumed it.

/** Minimal, stable Account census for access-authorized key preparation. */
export async function listCurrentSessionAudienceAccountsInTx(input: {
    tx: Pick<Tx, "session" | "account">;
    sessionId: string;
    afterAccountId?: string | null;
    limit: number;
}): Promise<readonly { accountId: string }[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Invalid audience page size");
    const audience = await buildSessionReadableAccountWhereInTx(input);
    const rows = await input.tx.account.findMany({
        where: { AND: [
            audience,
            ...(input.afterAccountId ? [{ id: { gt: input.afterAccountId } }] : []),
        ] },
        select: { id: true }, orderBy: { id: "asc" }, take: input.limit,
    });
    return rows.map(row => ({ accountId: row.id }));
}
