import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { resolveResourceGrantMatchedContributionsFromFacts, projectResourceGrantRows, type ResourceGrantPrincipalFacts } from '@/app/teams/resourceGrantAccess';
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
    qualifySessionTeamAuthenticationsInTx,
    resolveQualifiedSessionTeamIdsInTx,
    type SessionAccessAuthentication,
} from "./sessionAccessAuthentication";

import { SESSION_CAPABILITY_RULES, SESSION_ACCESS_LEVEL_ORDER, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { isActiveHomeAccountStatus } from '@happier-dev/protocol/home/governance';
import { TEAM_PRINCIPAL_ROLES_V1, isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
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
/** A projection reader also answers the same-transaction Team membership existence read. */
export type SessionAccessProjectionReader = Pick<Tx, "session" | "teamMembership">;
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
        ...(includeGuests ? {} : { role: { in: [...TEAM_PRINCIPAL_ROLES_V1] } }),
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
    /** No requested Account holds a Team membership in this same read (`readSessionAccessProjectionContextInTx`). */
    readonly withoutTeamMemberships?: boolean;
}

/**
 * Request-shape context for one projection read in the caller's transaction. An
 * Account without any Team membership row can match no Team or Group grant, so one
 * indexed existence read lets its projection leave their relation filters out: the
 * engine compiles each of them against the wide Team, Membership and Account types,
 * which costs more CPU than the read itself (P03-SERVER-CPU-2).
 */
export async function readSessionAccessProjectionContextInTx(
    reader: Pick<Tx, "teamMembership">,
    accountIds: readonly string[],
): Promise<SessionAccessProjectionContext> {
    if (accountIds.length === 0 || !isSessionCollaborationEnabled()) return {};
    const membership = await reader.teamMembership.findFirst({ where: { accountId: { in: [...accountIds] } }, select: { id: true } });
    return membership ? {} : { withoutTeamMemberships: true };
}

export function buildSessionAccessProjectionSelectForAccounts(accountIds: readonly string[], context: SessionAccessProjectionContext = {}) {
    const snapshot = context.collectiveAccessSnapshot;
    if (snapshot && (accountIds.length !== 1 || snapshot.accountId !== accountIds[0])) {
        throw new Error("Session access projection snapshot belongs to another Account");
    }
    const membershipIdentity = snapshot ? { id: { in: snapshot.memberships.map(membership => membership.id) } } : {};
    const teamMembership = { ...buildSessionAccessMembershipWhere(accountIds, false), ...membershipIdentity };
    const groupMembership = { teamMembership: { ...buildSessionAccessMembershipWhere(accountIds, true), ...membershipIdentity } };
    const collectiveEnabled = context.mode !== "legacy_owner_or_direct" && !context.withoutTeamMemberships && isSessionCollaborationEnabled();
    const teamIds = !collectiveEnabled ? [] : snapshot
        ? [...new Set(snapshot.memberships.filter(membership => isTeamPrincipalRoleV1(membership.role)).map(membership => membership.teamId))]
        : undefined;
    const groupIds = !collectiveEnabled ? [] : snapshot
        ? [...new Set(snapshot.memberships.flatMap(membership => membership.groupMemberships.map(group => group.teamGroupId)))]
        : undefined;
    return {
        id: true,
        primaryTeamId: true,
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        account: { select: { status: true } },
        grants: {
            // A known-empty principal set matches no grant: its branch, and the relation
            // filters the engine would compile for it, stay out of the request.
            where: { OR: [
                { principalKind: 'account', accountId: { in: [...accountIds] }, account: { status: 'active' } },
                ...(teamIds?.length === 0 ? [] : [{ principalKind: 'team', ...(teamIds ? { teamId: { in: teamIds } } : {}), team: { archivedAt: null,
                    ...(snapshot || !collectiveEnabled ? {} : { memberships: { some: teamMembership } }) } }]),
                ...(groupIds?.length === 0 ? [] : [{ principalKind: 'group', ...(groupIds ? { teamGroupId: { in: groupIds } } : {}),
                    teamGroup: { archivedAt: null, team: { archivedAt: null },
                        ...(snapshot || !collectiveEnabled ? {} : { memberships: { some: groupMembership } }) } }]),
            ] },
            select: {
                id: true, principalKind: true, accountId: true, teamId: true, teamGroupId: true,
                effectiveAt: true, accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true,
                account: { select: { status: true } },
                team: { select: { authenticationPolicy: true, memberships: { where: teamMembership,
                    select: { accountId: true, role: true, sessionAccessStartsAt: true } } } },
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
    const grants = matchSessionGrantContributions(row, accountId, options.mode !== 'legacy_owner_or_direct')
        .filter(({ team }) => !team || options.includeCredentialRestrictedTeamEntitlements || options.qualifiedTeamIds?.has(team.id))
        .map(({ grant }) => grant);
    const access = projectApplicableSessionGrants(accountId, row.id, owner, grants);
    // Authored context is safe display context for every authorized reader. It is
    // not audience authority and may name a Team unrelated to the decisive grant.
    return access ? { ...access, primaryTeamId: row.primaryTeamId ?? null } : null;
}

interface SessionGrantContribution {
    readonly grant: ApplicableSessionGrant;
    readonly team?: Readonly<{ id: string; authenticationPolicy: unknown }>;
}

/** Storage filters supply current lifecycle facts; Session alone adds its strict history horizon. */
function matchSessionGrantContributions(row: SessionAccessProjectionRow, accountId: string, collective: boolean): SessionGrantContribution[] {
    const projected = projectResourceGrantRows(row.grants);
    const facts: { principal: ResourceGrantPrincipalFacts; contribution: SessionGrantContribution }[] = projected.accountGrants.map(grant => ({
        principal: { kind: 'account', accountId: grant.accountId, active: isActiveHomeAccountStatus(grant.account.status) },
        contribution: { grant: { source: { kind: 'direct', shareId: grant.id }, accessLevel: grant.accessLevel,
            canApprovePermissions: grant.canApprovePermissions } },
    }));
    if (collective) {
        for (const grant of projected.teamGrants) facts.push({
            principal: { kind: 'team', memberships: grant.team.memberships.map(member => ({
                accountId: member.accountId, role: member.role,
                effective: isGrantAfterMembershipHorizon(grant.effectiveAt!, member.sessionAccessStartsAt),
            })) },
            contribution: { team: { id: grant.teamId, authenticationPolicy: grant.team.authenticationPolicy }, grant: {
                source: { kind: 'team', teamId: grant.teamId, requiredByTeamPolicy: grant.requiredByTeamPolicy },
                accessLevel: grant.accessLevel, canApprovePermissions: grant.canApprovePermissions,
            } },
        });
        for (const grant of projected.groupGrants) facts.push({
            principal: { kind: 'group', memberships: grant.teamGroup.memberships.map(member => ({
                accountId: member.teamMembership.accountId,
                effective: isGrantAfterMembershipHorizon(grant.effectiveAt!, member.sessionAccessStartsAt),
            })) },
            contribution: { team: { id: grant.teamGroup.teamId, authenticationPolicy: grant.teamGroup.team.authenticationPolicy }, grant: {
                source: { kind: 'group', teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId },
                accessLevel: grant.accessLevel, canApprovePermissions: grant.canApprovePermissions,
            } },
        });
    }
    return resolveResourceGrantMatchedContributionsFromFacts(facts, accountId);
}

/** Team policy facts are projected from the same unified Session grant rows. */
function sessionGrantTeams(row: SessionAccessProjectionRow) {
    const grants = projectResourceGrantRows(row.grants);
    return [
        ...grants.teamGrants.map(grant => ({ id: grant.teamId, authenticationPolicy: grant.team.authenticationPolicy })),
        ...grants.groupGrants.map(grant => ({ id: grant.teamGroup.teamId, authenticationPolicy: grant.teamGroup.team.authenticationPolicy })),
    ];
}

export type SessionAccessOperationDecision =
    | Readonly<{ status: "allowed"; access: EffectiveSessionAccess }>
    | Readonly<{ status: "authentication_required" }>
    | Readonly<{ status: "authentication_unavailable" }>
    | Readonly<{ status: "unavailable" }>;

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

export type SessionAccessOperationInput = Readonly<{
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
    }>;
export type SessionAccessCapabilityRequest = Pick<SessionAccessOperationInput, 'capability' | 'accessMode'>;
type SessionAccessActor = Omit<SessionAccessOperationInput, 'capability' | 'accessMode'>;
type SessionTeamQualifications = Awaited<ReturnType<typeof qualifySessionTeamAuthenticationsInTx>>;

/** Single-operation callers consume the same batch-of-one capability decision. */
export async function resolveSessionAccessForOperation(reader: Tx, input: SessionAccessOperationInput): Promise<SessionAccessOperationDecision> {
    const { capability, accessMode, ...actor } = input;
    return (await resolveSessionAccessCapabilityDecisions(reader, actor, [{ capability, accessMode }]))[0]!;
}

/** One row/facts pass, with independent capability and released-reader projections. */
export async function resolveSessionAccessCapabilityDecisions(reader: Tx, actor: SessionAccessActor,
    requests: readonly SessionAccessCapabilityRequest[], teamQualifications?: SessionTeamQualifications,
): Promise<readonly SessionAccessOperationDecision[]> {
    if (requests.length === 0) return [];
    const principal = actor.authentication.sessionRuntimePrincipal;
    if (principal && !await verifyCurrentMaterializedRunnerPrincipalInTx(reader, principal)) {
        return requests.map(() => ({ status: 'unavailable' }));
    }
    return resolveSessionAccessCapabilityDecisionsFromRow(reader, actor, requests, actor.row, teamQualifications);
}

async function resolveSessionAccessCapabilityDecisionsFromRow(reader: Tx, actor: SessionAccessActor,
    requests: readonly SessionAccessCapabilityRequest[], suppliedRow: SessionAccessProjectionRow | null | undefined,
    teamQualifications?: SessionTeamQualifications,
): Promise<readonly SessionAccessOperationDecision[]> {
    const unavailable = (): readonly SessionAccessOperationDecision[] => requests.map(() => ({ status: 'unavailable' }));
    const tokenGrant = actor.authentication.apiTokenGrant;
    const exactTokenAction = tokenGrant && actor.apiTokenAction;
    if (tokenGrant && exactTokenAction && !evaluateApiTokenGrantV1({ grant: tokenGrant, actionId: exactTokenAction.actionId,
        target: { kind: 'session', sessionId: actor.sessionId }, targetMachineId: exactTokenAction.targetMachineId }).ok) return unavailable();
    const row = suppliedRow === undefined ? await reader.session.findUnique({ where: { id: actor.sessionId },
        select: withSessionContentSelect(buildSessionAccessProjectionSelect(actor.accountId,
            await readSessionAccessProjectionContextInTx(reader, [actor.accountId]))) }).then(decodeSessionStoredContent) : suppliedRow;
    if (!row || row.id !== actor.sessionId) return unavailable();
    const runtimePrincipal = actor.authentication.sessionRuntimePrincipal;
    const runtimeAccess = runtimePrincipal ? projectExactSessionRuntimeAccess(row, actor.accountId, actor.authentication) : null;
    if (runtimePrincipal && !runtimeAccess) return unavailable();
    const owner = row.accountId === actor.accountId;
    const shareable = isSessionTranscriptShareable(row);
    const collective = !runtimePrincipal && !owner && shareable
        && requests.some(request => request.accessMode !== 'legacy_owner_or_direct');
    const contributions = !runtimePrincipal && (owner || shareable) ? matchSessionGrantContributions(row, actor.accountId, collective) : [];
    const independent = runtimeAccess ?? ((owner && isActiveHomeAccountStatus(row.account.status)) || (!owner && shareable)
        ? projectApplicableSessionGrants(actor.accountId, row.id, owner, contributions.filter(item => !item.team).map(item => item.grant)) : null);
    const independentAccess = independent ? { ...independent, primaryTeamId: row.primaryTeamId ?? null } : null;
    const qualifications = teamQualifications ?? await qualifySessionTeamAuthenticationsInTx(reader, {
        accountId: actor.accountId, authentication: actor.authentication,
        teams: contributions.flatMap(({ team }) => team ? [team] : []),
    });
    const grants: ApplicableSessionGrant[] = [];
    const unqualified: { capabilities: EffectiveSessionAccess['capabilities']; status: 'authentication_required' | 'unavailable' }[] = [];
    for (const contribution of contributions) {
        const qualification = contribution.team ? qualifications.get(contribution.team.id) ?? { status: 'unavailable' as const } : null;
        if (qualification && qualification.status !== 'satisfied') unqualified.push({ capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [contribution.grant] }), status: qualification.status });
        else grants.push(contribution.grant);
    }
    const collectiveAccess = collective ? projectApplicableSessionGrants(actor.accountId, row.id, false, grants) : null;
    const access = collectiveAccess ? { ...collectiveAccess, primaryTeamId: row.primaryTeamId ?? null } : null;
    const ceiling = tokenGrant ? new Set<string>(resolveApiTokenSessionCapabilityCeilingV1(tokenGrant)) : null;
    const cap = (resolved: EffectiveSessionAccess): EffectiveSessionAccess => {
        if (!ceiling) return resolved;
        const capabilities = { ...resolved.capabilities };
        for (const capability of Object.keys(capabilities) as SessionCapability[]) capabilities[capability] &&= ceiling.has(capability);
        return { ...resolved, capabilities };
    };
    const cappedIndependent = independentAccess ? cap(independentAccess) : null;
    const cappedCollective = access ? cap(access) : null;
    let disclosure: Promise<boolean> | undefined;
    const admit = async (resolved: EffectiveSessionAccess, projected: EffectiveSessionAccess, request: SessionAccessCapabilityRequest): Promise<SessionAccessOperationDecision> => {
        if (request.capability !== undefined && !(exactTokenAction ? resolved : projected).capabilities[request.capability]) return { status: 'unavailable' };
        const destinationSessionId = actor.authentication.contentDisclosureSessionId;
        if (request.capability === 'readTranscript' && destinationSessionId && destinationSessionId !== actor.sessionId) {
            disclosure ??= mayInjectSessionContextInTx(reader, { configuringAccountId: actor.accountId, sourceSessionId: actor.sessionId,
                destinationSessionId, authentication: actor.authentication }).then(result => result.ok);
            if (!await disclosure) return { status: 'unavailable' };
        }
        return { status: 'allowed', access: projected };
    };
    const decisions: SessionAccessOperationDecision[] = [];
    for (const request of requests) {
        if (runtimePrincipal || request.accessMode === 'legacy_owner_or_direct' || independentAccess?.level === 'owner') {
            decisions.push(independentAccess ? await admit(independentAccess, cappedIndependent!, request) : { status: 'unavailable' });
            continue;
        }
        if (access && (request.capability === undefined || access.capabilities[request.capability])) {
            decisions.push(await admit(access, cappedCollective!, request));
            continue;
        }
        const relevant = unqualified.filter(({ capabilities }) => request.capability === undefined || capabilities[request.capability]);
        decisions.push({ status: relevant.some(item => item.status === 'authentication_required') ? 'authentication_required'
            : relevant.some(item => item.status === 'unavailable') || (request.capability === undefined && contributions.some(item => item.team))
                ? 'authentication_unavailable' : 'unavailable' });
    }
    return decisions;
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
export async function resolveStructuralSessionAccess(reader: SessionAccessProjectionReader, input: {
    accountId: string; sessionId: string; row?: SessionAccessProjectionRow;
}): Promise<EffectiveSessionAccess | null> {
    const row = input.row ?? await reader.session.findUnique({ where: { id: input.sessionId }, select: withSessionContentSelect(
        buildSessionAccessProjectionSelect(input.accountId, await readSessionAccessProjectionContextInTx(reader, [input.accountId]))) }).then(decodeSessionStoredContent);
    return row && (input.row === undefined || row.id === input.sessionId) ? projectEffectiveSessionAccess(row, input.accountId, {
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

/** One actor's same-snapshot facts serve all requested capability projections. */
export async function resolveSessionAccessCapabilitiesForRowsInTx(reader: Tx, actor: Omit<SessionAccessActor, 'sessionId' | 'row'>,
    rows: readonly SessionAccessProjectionRow[], requests: readonly SessionAccessCapabilityRequest[],
): Promise<readonly ReadonlyMap<string, SessionAccessOperationDecision>[]> {
    const results = requests.map(() => new Map<string, SessionAccessOperationDecision>());
    if (requests.length === 0 || rows.length === 0) return results;
    const principal = actor.authentication.sessionRuntimePrincipal;
    if (principal && !await verifyCurrentMaterializedRunnerPrincipalInTx(reader, principal)) {
        for (const row of rows) for (const result of results) result.set(row.id, { status: 'unavailable' });
        return results;
    }
    const teams = principal || requests.every(request => request.accessMode === 'legacy_owner_or_direct') ? [] : rows
        .filter(row => row.accountId !== actor.accountId && isSessionTranscriptShareable(row))
        .flatMap(sessionGrantTeams);
    const qualifications = await qualifySessionTeamAuthenticationsInTx(reader, { ...actor, teams });
    for (const row of rows) {
        const decisions = await resolveSessionAccessCapabilityDecisionsFromRow(reader, { ...actor, sessionId: row.id }, requests, row, qualifications);
        decisions.forEach((decision, index) => results[index]!.set(row.id, decision));
    }
    return results;
}

/** Existing single-capability row consumers are a batch of one projection. */
export async function resolveSessionAccessForRowsInTx(reader: Tx, input: Omit<SessionAccessOperationInput, 'sessionId' | 'row'>,
    rows: readonly SessionAccessProjectionRow[],
): Promise<ReadonlyMap<string, SessionAccessOperationDecision>> {
    const { capability, accessMode, ...actor } = input;
    return (await resolveSessionAccessCapabilitiesForRowsInTx(reader, actor, rows, [{ capability, accessMode }]))[0]!;
}

/**
 * Batch row loading for one actor; every decision remains the exact operation
 * resolver. A requested Session without a row is absent from the result, which
 * callers read as the single resolver's `unavailable`.
 */
export async function resolveSessionAccessDecisionsForSessionsInTx(
    reader: Tx,
    input: Omit<Parameters<typeof resolveSessionAccessForOperation>[1], 'sessionId' | 'row'> & Readonly<{ sessionIds: readonly string[] }>,
): Promise<ReadonlyMap<string, SessionAccessOperationDecision>> {
    const { sessionIds: requestedSessionIds, ...operation } = input;
    const result = new Map<string, SessionAccessOperationDecision>();
    const sessionIds = [...new Set(requestedSessionIds)];
    // This chunks database parameters, never the authorized result set.
    const projectionContext = sessionIds.length === 0 ? {} : await readSessionAccessProjectionContextInTx(reader, [operation.accountId]);
    for (let offset = 0; offset < sessionIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const rows = await reader.session.findMany({
            where: { id: { in: sessionIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE) } },
            select: withSessionContentSelect(buildSessionAccessProjectionSelect(operation.accountId, projectionContext)),
        }).then(decodeSessionStoredContent);
        for (const [id, decision] of await resolveSessionAccessForRowsInTx(reader, operation, rows)) result.set(id, decision);
    }
    return result;
}

export async function resolveEffectiveSessionAccessForSessionsInTx(reader: Tx, input: Readonly<{
    accountId: string; sessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, EffectiveSessionAccess>> {
    const result = new Map<string, EffectiveSessionAccess>();
    for (const [id, decision] of await resolveSessionAccessDecisionsForSessionsInTx(reader, input)) {
        if (decision.status === "allowed") result.set(id, decision.access);
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
    /** This Session's row from the same transaction, read with `buildSessionAccessProjectionSelect(accountId)`. */
    row?: SessionAccessProjectionRow;
}): Promise<SessionCapabilityAssertion> {
    const decision = await resolveSessionAccessForOperation(input.tx, {
        accountId: input.accountId,
        sessionId: input.sessionId,
        authentication: input.authentication,
        capability: input.capability,
        ...(input.row ? { row: input.row } : {}),
    });
    if (decision.status !== "allowed") return { ok: false, reason: decision.status };
    const access = decision.access;
    return access?.capabilities[input.capability] ? { ok: true, access } : { ok: false, reason: "unavailable" };
}
/** Execution-custody operations stay owner-only independently of human capability names. */
export async function assertSessionOwnerInTx(input: {
    tx: SessionAccessProjectionReader; accountId: string; sessionId: string;
    /** This Session's row from the same transaction, read with `buildSessionAccessProjectionSelect(accountId)`. */
    row?: SessionAccessProjectionRow;
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
            { grants: { some: { principalKind: 'team', teamId: input.teamId, team: { archivedAt: null } } } },
        ] },
        select: withSessionContentSelect(SESSION_TRANSCRIPT_PUBLICATION_SELECT),
    }).then(decodeSessionStoredContent);
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
            select: withSessionContentSelect(buildSessionAccessProjectionSelectForAccounts(batch,
                await readSessionAccessProjectionContextInTx(tx, batch))),
        }).then(decodeSessionStoredContent);
        if (!row || row.id !== input.sessionId) continue;
        const qualifiedTeamIds = await resolveQualifiedSessionTeamIdsInTx(tx, {
            accountIds: batch,
            teams: sessionGrantTeams(row),
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
        const projectionContext = await readSessionAccessProjectionContextInTx(tx, accountBatch);
        for (let sessionOffset = 0; sessionOffset < sessionIds.length; sessionOffset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const sessionBatch = sessionIds.slice(sessionOffset, sessionOffset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            const rows = await tx.session.findMany({
                where: { id: { in: sessionBatch } },
                select: withSessionContentSelect(buildSessionAccessProjectionSelectForAccounts(accountBatch, projectionContext)),
            }).then(decodeSessionStoredContent);
            const teams = rows.flatMap(sessionGrantTeams);
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

export async function resolveStructuralSessionAccessForAccountsInTx(tx: SessionAccessProjectionReader, input: {
    sessionId: string; accountIds: readonly string[];
}): Promise<ReadonlyMap<string, EffectiveSessionAccess | null>> {
    const result = new Map<string, EffectiveSessionAccess | null>();
    const accountIds = [...new Set(input.accountIds)];
    // The repeated Account filters remain below SQLite's conservative 999-bind
    // boundary. This chunks transport parameters, never the authorized result set.
    for (let offset = 0; offset < accountIds.length; offset += 100) {
        const batch = accountIds.slice(offset, offset + 100);
        const row = await tx.session.findUnique({ where: { id: input.sessionId }, select: withSessionContentSelect(
            buildSessionAccessProjectionSelectForAccounts(batch, await readSessionAccessProjectionContextInTx(tx, batch))) }).then(decodeSessionStoredContent);
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
export async function resolveStructuralSessionAccessForSessionsInTx(tx: SessionAccessProjectionReader, input: {
    sessionIds: readonly string[]; accountIds: readonly string[];
}): Promise<ReadonlyMap<string, ReadonlyMap<string, EffectiveSessionAccess | null>>> {
    const result = new Map<string, Map<string, EffectiveSessionAccess | null>>();
    const accountIds = [...new Set(input.accountIds)];
    const sessionIds = [...new Set(input.sessionIds)];
    if (accountIds.length === 0 || sessionIds.length === 0) return result;
    for (let accountOffset = 0; accountOffset < accountIds.length; accountOffset += 100) {
        const accountBatch = accountIds.slice(accountOffset, accountOffset + 100);
        const projectionContext = await readSessionAccessProjectionContextInTx(tx, accountBatch);
        for (let sessionOffset = 0; sessionOffset < sessionIds.length; sessionOffset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
            const sessionBatch = sessionIds.slice(sessionOffset, sessionOffset + SESSION_ACCESS_SESSION_BATCH_SIZE);
            const rows = await tx.session.findMany({
                where: { id: { in: sessionBatch } },
                select: withSessionContentSelect(buildSessionAccessProjectionSelectForAccounts(accountBatch, projectionContext)),
            }).then(decodeSessionStoredContent);
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
