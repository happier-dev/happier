import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import type { Prisma } from "@prisma/client";
import type { Tx } from "@/storage/inTx";
import { TEAM_PRINCIPAL_ROLES_V1, isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { type SessionAudienceSelectionV1 } from '@happier-dev/protocol/sessions/listing/query';
import { resolveTeamMembershipContextInTx } from "@/app/teams/memberships/effectiveMembership";
import { resolveTeamGroupMembershipContextInTx } from "@/app/teams/groups/effectiveGroupMembership";
import { createSessionTranscriptShareableWhere, isSessionTranscriptShareable, SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { SESSION_CAPABILITY_RULES, SESSION_ACCESS_LEVEL_ORDER, buildSessionAccessMembershipWhere, isSessionCollaborationEnabled, type SessionCapability } from "./sessionAccess";
import {
    qualifySessionTeamAuthenticationInTx,
    resolveQualifiedSessionTeamIdsInTx,
    type SessionAccessAuthentication,
} from "./sessionAccessAuthentication";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";

export type AccessWhereInput = { accountId: string; capability: SessionCapability };
type LegacyAccessWhereInput = AccessWhereInput & { mode: "legacy_owner_or_direct" };
export type EffectiveAccessWhereInput = AccessWhereInput & {
    mode: "effective_access_v1";
    tx: Tx;
    authentication: SessionAccessAuthentication;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
};

const SESSION_COLLECTIVE_ACCESS_MEMBERSHIP_SELECT = {
    id: true,
    accountId: true,
    teamId: true,
    role: true,
    sessionAccessStartsAt: true,
    team: { select: { authenticationPolicy: true } },
    groupMemberships: {
        where: { group: { archivedAt: null } },
        select: { teamGroupId: true, sessionAccessStartsAt: true },
    },
} as const satisfies Prisma.TeamMembershipSelect;

type SessionCollectiveAccessMembership = Prisma.TeamMembershipGetPayload<{
    select: typeof SESSION_COLLECTIVE_ACCESS_MEMBERSHIP_SELECT;
}>;

/** One request/transaction-local membership and credential view for all list selectors. */
export type SessionCollectiveAccessSnapshot = Readonly<{
    accountId: string;
    /** Captured by access admission in the consuming transaction. */
    accountActive?: boolean;
    memberships: readonly SessionCollectiveAccessMembership[];
    qualifiedTeamIds: ReadonlySet<string>;
    /** The Account's direct shares, read once by `accountId` in this snapshot. */
    directShares?: readonly SessionDirectShareFact[];
}>;

type SessionDirectShareFact = Readonly<{ sessionId: string; accessLevel: string; canApprovePermissions: boolean }>;

function grantCapabilityLevels(capability: SessionCapability) {
    const rule = SESSION_CAPABILITY_RULES[capability];
    const levels = (["view", "edit", "admin"] as const).filter(level =>
        SESSION_ACCESS_LEVEL_ORDER.indexOf(level) >= SESSION_ACCESS_LEVEL_ORDER.indexOf(rule.level));
    return { levels, delegation: rule.delegation === true };
}

function grantCapabilityWhere(capability: SessionCapability) {
    const { levels, delegation } = grantCapabilityLevels(capability);
    return { accessLevel: { in: levels }, ...(delegation ? { canApprovePermissions: true } : {}) };
}

/** The same capability rule as `grantCapabilityWhere`, applied to captured share facts. */
function directShareSessionIdsFor(capability: SessionCapability, shares: readonly SessionDirectShareFact[]): string[] {
    const { levels, delegation } = grantCapabilityLevels(capability);
    return shares.flatMap(share => (levels as readonly string[]).includes(share.accessLevel)
        && (!delegation || share.canApprovePermissions) ? [share.sessionId] : []);
}

function directShareWhere(input: AccessWhereInput, activeAccountResolved: boolean) {
    return { principalKind: 'account', accountId: input.accountId,
        ...(activeAccountResolved ? {} : { account: { status: "active" as const } }),
        ...grantCapabilityWhere(input.capability) } satisfies Prisma.SessionGrantWhereInput;
}

/**
 * `directShareSessionIds` is the same direct-share arm already read through its
 * viewer-keyed index in the consuming snapshot. An ordered page cannot use any
 * Session index for a correlated EXISTS inside this OR, so it scanned every
 * Account's Sessions; exact ids let PostgreSQL combine the owner index with the
 * primary key. Row-bounded callers keep the EXISTS form.
 */
function composeAccessWhereBranches(input: AccessWhereInput, collective: Prisma.SessionWhereInput[] = [], activeAccountResolved = false,
    directShareSessionIds?: readonly string[]): Prisma.SessionWhereInput[] {
    const rule = SESSION_CAPABILITY_RULES[input.capability];
    const owner: Prisma.SessionWhereInput = { accountId: input.accountId,
        ...(activeAccountResolved ? {} : { account: { status: "active" as const } }) };
    if (rule.level === "owner") return [owner];
    return [
        owner,
        { accountId: { not: input.accountId }, AND: [createSessionTranscriptShareableWhere(), { OR: [
            directShareSessionIds
                ? { id: { in: [...new Set(directShareSessionIds)] } }
                : { grants: { some: directShareWhere(input, activeAccountResolved) } },
            ...collective,
        ] }] },
    ];
}

function composeAccessWhere(input: AccessWhereInput, collective: Prisma.SessionWhereInput[] = [], activeAccountResolved = false,
    directShareSessionIds?: readonly string[]): Prisma.SessionWhereInput {
    const branches = composeAccessWhereBranches(input, collective, activeAccountResolved, directShareSessionIds);
    return branches.length === 1 ? branches[0]! : { OR: branches };
}

/**
 * Legacy owner/direct visibility for an ordered Session page, compiled in the
 * page's own snapshot: the caller's Account status and direct shares are read
 * once through their keys, so the page is served by Session indexes.
 */
async function readDirectShareFactsInTx(tx: Tx, accountIds: readonly string[]) {
    return tx.sessionGrant.findMany({ where: { principalKind: 'account', accountId: { in: [...accountIds] } },
        select: { sessionId: true, accountId: true, accessLevel: true, canApprovePermissions: true } });
}

export async function resolveLegacySessionPageAccessQueryInTx(tx: Tx, input: AccessWhereInput): Promise<Readonly<{
    where: Prisma.SessionWhereInput;
    queryBranches: readonly Prisma.SessionWhereInput[];
}>> {
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
    const shares = account?.status === "active" && SESSION_CAPABILITY_RULES[input.capability].level !== "owner"
        ? await readDirectShareFactsInTx(tx, [input.accountId]) : [];
    const queryBranches: Prisma.SessionWhereInput[] = account?.status === "active"
        ? composeAccessWhereBranches(input, [], true, directShareSessionIdsFor(input.capability, shares))
        : [{ id: { in: [] } }];
    return { where: queryBranches.length === 1 ? queryBranches[0]! : { OR: queryBranches }, queryBranches };
}

/** Compose with domain filters through AND so a caller cannot overwrite access. */
export function buildSessionAccessWhere(input: LegacyAccessWhereInput): Prisma.SessionWhereInput;
export function buildSessionAccessWhere(input: EffectiveAccessWhereInput): Promise<Prisma.SessionWhereInput>;
export function buildSessionAccessWhere(input: LegacyAccessWhereInput | EffectiveAccessWhereInput): Prisma.SessionWhereInput | Promise<Prisma.SessionWhereInput> {
    return input.mode === "legacy_owner_or_direct" ? composeAccessWhere(input) : buildEffectiveSessionAccessWhere(input);
}

/**
 * Prisma only compares columns on the same model. Resolve membership cutoffs
 * inside the consuming Serializable transaction, then compile ordinary EXISTS
 * branches. The same transaction must execute the page/count/child read or CAS;
 * a retry recompiles the membership facts. No Session IDs or pages are filtered
 * in memory, and the exact membership identity excludes removed/rejoined rows.
 */
async function buildEffectiveSessionAccessWhere(input: EffectiveAccessWhereInput): Promise<Prisma.SessionWhereInput> {
    return (await resolveEffectiveSessionAccessWhere(input)).where;
}

export async function resolveEffectiveSessionAccessWhere(
    input: EffectiveAccessWhereInput,
): Promise<Readonly<{
    where: Prisma.SessionWhereInput;
    /** Disjoint arms of the same admitted relation for ordered keyset reads. */
    queryBranches: readonly Prisma.SessionWhereInput[];
    qualifiedTeamIds: ReadonlySet<string>;
    collectiveAccessSnapshot: SessionCollectiveAccessSnapshot;
}>> {
    // The consuming transaction captures this caller fact once. Leaving the
    // same constant Account join inside every candidate OR forces PostgreSQL
    // to hash/sort the Session relation before applying an ordered page limit.
    const accountActive = input.collectiveAccessSnapshot?.accountActive
        ?? ((await input.tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } }))?.status === "active");
    if (!accountActive) {
        return {
            where: { id: { in: [] } }, queryBranches: [{ id: { in: [] } }], qualifiedTeamIds: new Set(),
            collectiveAccessSnapshot: { accountId: input.accountId, accountActive, memberships: [], qualifiedTeamIds: new Set() },
        };
    }
    const runtimePrincipal = input.authentication.sessionRuntimePrincipal;
    if (runtimePrincipal) {
        const capabilities = projectSessionAccessCapabilitiesV1({
            owner: false,
            grants: [{ accessLevel: "edit", canApprovePermissions: false }],
        });
        const allowed = runtimePrincipal.accountId === input.accountId
            && await verifyCurrentMaterializedRunnerPrincipalInTx(input.tx, runtimePrincipal) !== null
            && capabilities[input.capability];
        const where: Prisma.SessionWhereInput = allowed
                ? {
                    id: runtimePrincipal.sessionId,
                    accountId: runtimePrincipal.accountId,
                }
                : { id: { in: [] } };
        return {
            where,
            queryBranches: [where],
            qualifiedTeamIds: new Set(),
            collectiveAccessSnapshot: {
                accountId: input.accountId,
                accountActive,
                memberships: [],
                qualifiedTeamIds: new Set(),
            },
        };
    }
    const collectiveAccessSnapshot = {
        ...(input.collectiveAccessSnapshot ?? await resolveSessionCollectiveAccessSnapshotInTx(input)),
        accountActive,
    };
    const collective = await buildCollectiveAccessBranches(
        { ...input, collectiveAccessSnapshot },
        {},
    );
    const directShares = collectiveAccessSnapshot.directShares;
    const queryBranches = composeAccessWhereBranches(input, collective, true,
        directShares && directShareSessionIdsFor(input.capability, directShares));
    return {
        where: queryBranches.length === 1 ? queryBranches[0]! : { OR: queryBranches },
        queryBranches,
        qualifiedTeamIds: collectiveAccessSnapshot.qualifiedTeamIds,
        collectiveAccessSnapshot,
    };
}

type CollectiveAudienceScope = Readonly<{
    teamIds: ReadonlySet<string>;
    groupIdsByTeamId: ReadonlyMap<string, ReadonlySet<string>>;
}>;
type CollectiveScope = {
    teamId?: string;
    groupId?: string;
    teamOnly?: boolean;
    membershipId?: string;
    audience?: CollectiveAudienceScope;
};

type CollectiveGrantBucket = {
    sessionAccessStartsAt: Date | null;
    audienceIds: Set<string>;
    membershipIds: Set<string>;
};

function collectiveGrantBucket(
    buckets: Map<string, CollectiveGrantBucket>,
    sessionAccessStartsAt: Date | null,
): CollectiveGrantBucket {
    const key = sessionAccessStartsAt?.toISOString() ?? "unbounded";
    const existing = buckets.get(key);
    if (existing) return existing;
    const created = { sessionAccessStartsAt, audienceIds: new Set<string>(), membershipIds: new Set<string>() };
    buckets.set(key, created);
    return created;
}

async function resolveSessionCollectiveAccessSnapshotInTx(
    input: EffectiveAccessWhereInput,
): Promise<SessionCollectiveAccessSnapshot> {
    const snapshots = await resolveSessionCollectiveAccessSnapshotsInTx(input.tx, {
        accountIds: [input.accountId],
        authentication: input.authentication,
    });
    return snapshots.get(input.accountId)
        ?? { accountId: input.accountId, memberships: [], qualifiedTeamIds: new Set() };
}

/**
 * One membership and credential view for a set of Accounts sharing one
 * credential context.
 *
 * Background badge refresh asks for this on behalf of every recipient of one
 * batch, so the memberships behind them are read once for the set and the Team
 * qualification is taken once for the credential they share — not once per
 * Account and once per membership inside the transaction. A credential-bearing
 * caller resolves exactly one Account, which is the same single decision it
 * already took.
 */
export async function resolveSessionCollectiveAccessSnapshotsInTx(
    tx: Tx,
    input: Readonly<{ accountIds: readonly string[]; authentication: SessionAccessAuthentication }>,
): Promise<ReadonlyMap<string, SessionCollectiveAccessSnapshot>> {
    const accountIds = [...new Set(input.accountIds)];
    const snapshots = new Map<string, SessionCollectiveAccessSnapshot>();
    // A Session runtime principal carries no collective membership view — the
    // forward predicate answers it from the principal alone — so it reads none.
    if (input.authentication.sessionRuntimePrincipal || accountIds.length === 0) {
        for (const accountId of accountIds) {
            snapshots.set(accountId, { accountId, memberships: [], qualifiedTeamIds: new Set() });
        }
        return snapshots;
    }
    const shares = await readDirectShareFactsInTx(tx, accountIds);
    const sharesOf = (accountId: string) => shares.filter(share => share.accountId === accountId);
    if (!isSessionCollaborationEnabled()) {
        for (const accountId of accountIds) {
            snapshots.set(accountId, { accountId, memberships: [], qualifiedTeamIds: new Set(), directShares: sharesOf(accountId) });
        }
        return snapshots;
    }
    const memberships = await tx.teamMembership.findMany({
        where: {
            ...buildSessionAccessMembershipWhere(accountIds, true),
            team: { archivedAt: null },
        },
        select: SESSION_COLLECTIVE_ACCESS_MEMBERSHIP_SELECT,
    });
    const qualifiedTeamIds = await resolveQualifiedSessionTeamIdsInTx(tx, {
        accountIds,
        teams: memberships.map((membership) => ({
            id: membership.teamId,
            authenticationPolicy: membership.team.authenticationPolicy,
        })),
        authentication: input.authentication,
    });
    for (const accountId of accountIds) {
        const own = memberships.filter((membership) => membership.accountId === accountId);
        snapshots.set(accountId, {
            accountId,
            directShares: sharesOf(accountId),
            memberships: own,
            // An Account's qualified Teams stay its own memberships' Teams; the
            // batch only shares how the qualification was read.
            qualifiedTeamIds: new Set(own.flatMap((membership) =>
                qualifiedTeamIds.has(membership.teamId) ? [membership.teamId] : [])),
        });
    }
    return snapshots;
}

/** One compiler for current collective grants, including audience and exact history queries. */
async function buildCollectiveAccessBranches(
    input: EffectiveAccessWhereInput | Omit<EffectiveAccessWhereInput, "authentication">,
    scope: CollectiveScope = {},
    options: Readonly<{ includeCredentialRestrictedTeamEntitlements?: boolean }> = {},
): Promise<Prisma.SessionWhereInput[]> {
    if (SESSION_CAPABILITY_RULES[input.capability].level === "owner" || !isSessionCollaborationEnabled()) return [];
    const snapshot = "collectiveAccessSnapshot" in input ? input.collectiveAccessSnapshot : undefined;
    if (snapshot && snapshot.accountId !== input.accountId) {
        throw new Error("Session collective access snapshot belongs to another Account");
    }
    const memberships = (snapshot?.memberships ?? await input.tx.teamMembership.findMany({
        where: {
            ...buildSessionAccessMembershipWhere([input.accountId], true),
            team: { archivedAt: null },
            ...(scope.teamId ? { teamId: scope.teamId } : {}),
            ...(scope.membershipId ? { id: scope.membershipId } : {}),
        },
        select: SESSION_COLLECTIVE_ACCESS_MEMBERSHIP_SELECT,
    })).filter((membership) =>
        (!scope.teamId || membership.teamId === scope.teamId)
        && (!scope.membershipId || membership.id === scope.membershipId)
        && (!scope.audience
            || scope.audience.teamIds.has(membership.teamId)
            || membership.groupMemberships.some((group) =>
                scope.audience?.groupIdsByTeamId.get(membership.teamId)?.has(group.teamGroupId) === true)));
    const teamGrantBuckets = new Map<string, CollectiveGrantBucket>();
    const groupGrantBuckets = new Map<string, CollectiveGrantBucket>();
    const grant = grantCapabilityWhere(input.capability);
    const currentMembership = buildSessionAccessMembershipWhere([input.accountId], true);
    for (const membership of memberships) {
        if (!options.includeCredentialRestrictedTeamEntitlements) {
            if (snapshot) {
                if (!snapshot.qualifiedTeamIds.has(membership.teamId)) continue;
            } else if (!("authentication" in input)) {
                throw new Error("Credential-aware collective access requires operation authentication");
            } else {
                const qualification = await qualifySessionTeamAuthenticationInTx(input.tx, {
                    accountId: input.accountId,
                    team: { id: membership.teamId, authenticationPolicy: membership.team.authenticationPolicy },
                    authentication: input.authentication,
                });
                if (qualification.status !== "satisfied") continue;
            }
        }
        const audienceIncludesTeam = !scope.audience || scope.audience.teamIds.has(membership.teamId);
        if (!scope.groupId && audienceIncludesTeam && isTeamPrincipalRoleV1(membership.role)) {
            const bucket = collectiveGrantBucket(teamGrantBuckets, membership.sessionAccessStartsAt);
            bucket.audienceIds.add(membership.teamId);
            bucket.membershipIds.add(membership.id);
        }
        for (const group of membership.groupMemberships) {
            if (scope.teamOnly
                || (scope.groupId && group.teamGroupId !== scope.groupId)
                || (scope.audience
                    && !scope.audience.teamIds.has(membership.teamId)
                    && scope.audience.groupIdsByTeamId.get(membership.teamId)?.has(group.teamGroupId) !== true)) continue;
            const bucket = collectiveGrantBucket(groupGrantBuckets, group.sessionAccessStartsAt);
            bucket.audienceIds.add(group.teamGroupId);
            bucket.membershipIds.add(membership.id);
        }
    }
    const teamGrantAlternatives: Prisma.SessionGrantWhereInput[] = [...teamGrantBuckets.values()].map((bucket) => ({
        teamId: { in: [...bucket.audienceIds] },
        ...grant,
        ...(bucket.sessionAccessStartsAt === null ? {} : { effectiveAt: { gt: bucket.sessionAccessStartsAt } }),
        team: { archivedAt: null, memberships: { some: {
            ...currentMembership,
            id: { in: [...bucket.membershipIds] },
            role: { in: [...TEAM_PRINCIPAL_ROLES_V1] },
            sessionAccessStartsAt: bucket.sessionAccessStartsAt,
        } } },
    }));
    const groupGrantAlternatives: Prisma.SessionGrantWhereInput[] = [...groupGrantBuckets.values()].map((bucket) => ({
        teamGroupId: { in: [...bucket.audienceIds] },
        ...grant,
        ...(bucket.sessionAccessStartsAt === null ? {} : { effectiveAt: { gt: bucket.sessionAccessStartsAt } }),
        teamGroup: { archivedAt: null, team: { archivedAt: null }, memberships: { some: {
            teamMembershipId: { in: [...bucket.membershipIds] },
            sessionAccessStartsAt: bucket.sessionAccessStartsAt,
            teamMembership: { ...currentMembership, id: { in: [...bucket.membershipIds] } },
        } } },
    }));
    return [
        ...(teamGrantAlternatives.length > 0
            ? [{ grants: { some: { principalKind: 'team', OR: teamGrantAlternatives } } }]
            : []),
        ...(groupGrantAlternatives.length > 0
            ? [{ grants: { some: { principalKind: 'group', OR: groupGrantAlternatives } } }]
            : []),
    ];
}

/** Complete viewer-relative audience predicate; never derived from bounded row display. */
export async function createApplicableAudienceWhere(input: {
    tx: Tx;
    accountId: string;
    audiences: readonly SessionAudienceSelectionV1[];
    authentication: SessionAccessAuthentication;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
}): Promise<Prisma.SessionWhereInput> {
    if (input.audiences.length === 0) return {};
    const accessInput = {
        tx: input.tx,
        accountId: input.accountId,
        capability: "readTranscript",
        mode: "effective_access_v1",
        authentication: input.authentication,
        ...(input.collectiveAccessSnapshot
            ? { collectiveAccessSnapshot: input.collectiveAccessSnapshot }
            : {}),
    } as const;
    const manage = await buildSessionAccessWhere({ ...accessInput, capability: "manageAccess" });
    const applicable = async (
        scope: CollectiveScope,
        topology: Prisma.SessionWhereInput[],
    ): Promise<Prisma.SessionWhereInput> => {
        if (!isSessionCollaborationEnabled()) return { id: { in: [] } };
        const collective = await buildCollectiveAccessBranches(accessInput, scope);
        return { OR: [
            { AND: [manage, { OR: topology }] },
            ...(collective.length > 0 ? [{ AND: [createSessionTranscriptShareableWhere(), { OR: collective }] }] : []),
        ] };
    };
    const teamIds = new Set<string>();
    const groupIdsByTeamId = new Map<string, Set<string>>();
    let includesOutsideTeams = false;
    for (const audience of input.audiences) {
        if (audience.kind === "outside_teams") {
            includesOutsideTeams = true;
        } else if (audience.kind === "team") {
            teamIds.add(audience.teamId);
        } else {
            const groupIds = groupIdsByTeamId.get(audience.teamId) ?? new Set<string>();
            groupIds.add(audience.groupId);
            groupIdsByTeamId.set(audience.teamId, groupIds);
        }
    }
    const allTopology: Prisma.SessionWhereInput[] = [
        { grants: { some: { principalKind: 'team', team: { archivedAt: null } } } },
        { grants: { some: { principalKind: 'group', teamGroup: { archivedAt: null, team: { archivedAt: null } } } } },
    ];
    const branches: Prisma.SessionWhereInput[] = [];
    if (includesOutsideTeams) branches.push({ NOT: await applicable({}, allTopology) });
    if (teamIds.size > 0 || groupIdsByTeamId.size > 0) {
        const requestedGroupIds = [...groupIdsByTeamId.values()].flatMap((groupIds) => [...groupIds]);
        const selectedGroups = requestedGroupIds.length === 0
            ? []
            : await input.tx.teamGroup.findMany({
                where: { id: { in: requestedGroupIds } },
                select: { id: true, teamId: true },
            });
        const selectedGroupIds = selectedGroups
            .filter((group) => groupIdsByTeamId.get(group.teamId)?.has(group.id) === true)
            .map((group) => group.id);
        const groupTopology: Prisma.SessionGrantWhereInput[] = [
            ...(teamIds.size > 0 ? [{ teamGroup: {
                teamId: { in: [...teamIds] }, archivedAt: null, team: { archivedAt: null },
            } }] : []),
            ...(selectedGroupIds.length > 0 ? [{
                teamGroupId: { in: selectedGroupIds },
                teamGroup: { archivedAt: null, team: { archivedAt: null } },
            }] : []),
        ];
        const selectedTopology: Prisma.SessionWhereInput[] = [
            ...(teamIds.size > 0 ? [{ grants: { some: { principalKind: 'team',
                teamId: { in: [...teamIds] }, team: { archivedAt: null },
            } } }] : []),
            ...(groupTopology.length > 0 ? [{ grants: { some: { principalKind: 'group', OR: groupTopology } } }] : []),
        ];
        branches.push(await applicable({ audience: { teamIds, groupIdsByTeamId } }, selectedTopology));
    }
    return { OR: branches };
}

export type MembershipHistorySubject =
    | { kind: "team"; teamId: string; teamMembershipId: string; expectedAccountId: string }
    | { kind: "group"; teamId: string; groupId: string; accountId: string };

/** Caller applies encryption eligibility and pagination to this same-transaction predicate. */
export async function buildMembershipHistorySessionAccessWhereInTx(tx: Tx, input: {
    actorAccountId: string; subject: MembershipHistorySubject; authentication: SessionAccessAuthentication;
}): Promise<{ ok: true; recipientAccountId: string; where: Prisma.SessionWhereInput } | { ok: false; error: "unavailable" }> {
    const subject = input.subject;
    let recipientAccountId: string;
    let scope: CollectiveScope;
    if (subject.kind === "team") {
        const resolved = await resolveTeamMembershipContextInTx(tx, subject);
        if (!resolved.ok || !resolved.membership.effective || !isTeamPrincipalRoleV1(resolved.membership.role)) return { ok: false, error: "unavailable" };
        recipientAccountId = resolved.membership.accountId;
        scope = { teamId: subject.teamId, membershipId: resolved.membership.teamMembershipId, teamOnly: true };
    } else {
        const resolved = await resolveTeamGroupMembershipContextInTx(tx, subject);
        if (!resolved.ok || !resolved.groupMembership.effective) return { ok: false, error: "unavailable" };
        recipientAccountId = resolved.groupMembership.accountId;
        scope = { teamId: subject.teamId, groupId: subject.groupId, membershipId: resolved.groupMembership.teamMembershipId };
    }
    const actor = { tx, accountId: input.actorAccountId, mode: "effective_access_v1", authentication: input.authentication } as const;
    const collective = await buildCollectiveAccessBranches({
        tx, accountId: recipientAccountId, capability: "readTranscript", mode: "effective_access_v1",
        authentication: input.authentication,
    }, scope, { includeCredentialRestrictedTeamEntitlements: true });
    return { ok: true, recipientAccountId, where: { AND: [
        await buildSessionAccessWhere({ ...actor, capability: "readTranscript" }),
        await buildSessionAccessWhere({ ...actor, capability: "manageAccess" }),
        createSessionTranscriptShareableWhere(),
        collective.length > 0 ? { OR: collective } : { id: { in: [] } },
    ] } };
}

function membershipHorizonWhere(effectiveAt: Date) {
    return { OR: [{ sessionAccessStartsAt: null }, { sessionAccessStartsAt: { lt: effectiveAt } }] };
}

/**
 * Inverse of the same policy, for bounded recipients and eligible people queries.
 *
 * This is the structural audience: every Account a current grant reaches,
 * independent of the credential each of them would present. It permits
 * key/envelope preparation and census work, never content disclosure or effects,
 * which stay with the credential-aware forward predicate above.
 */
export async function buildSessionReadableAccountWhereInTx(input: {
    tx: Pick<Tx, "session">;
    sessionId: string;
    includeUnpublishedGrants?: boolean;
    capability?: SessionCapability;
}): Promise<Prisma.AccountWhereInput> {
    const capability = input.capability ?? "readTranscript";
    const grant = grantCapabilityWhere(capability);
    const session = await input.tx.session.findUnique({ where: { id: input.sessionId }, select: {
        ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        grants: { where: { OR: [
            { principalKind: 'team', ...grant, team: { archivedAt: null } },
            { principalKind: 'group', ...grant, teamGroup: { archivedAt: null, team: { archivedAt: null } } },
        ] }, select: { principalKind: true, accountId: true, teamId: true, teamGroupId: true, effectiveAt: true,
            team: { select: { authenticationPolicy: true } },
            teamGroup: { select: { teamId: true, team: { select: { authenticationPolicy: true } } } },
        } },
    } });
    if (!session) return { id: { in: [] } };
    const sources: Prisma.AccountWhereInput[] = [{ id: session.accountId }];
    const sessionGrants = projectResourceGrantRows(session.grants);
    if (SESSION_CAPABILITY_RULES[capability].level !== "owner" && (input.includeUnpublishedGrants || isSessionTranscriptShareable(session))) {
        sources.push({ SharedWithSessions: { some: { sessionId: input.sessionId, ...grant } } });
        if (isSessionCollaborationEnabled()) {
            for (const grant of sessionGrants.teamGrants) {
                sources.push({ teamMemberships: { some: {
                    teamId: grant.teamId, status: "active", role: { in: [...TEAM_PRINCIPAL_ROLES_V1] },
                    ...membershipHorizonWhere(grant.effectiveAt!), team: { archivedAt: null },
                } } });
            }
            for (const grant of sessionGrants.groupGrants) {
                sources.push({ teamMemberships: { some: {
                    teamId: grant.teamGroup.teamId, status: "active", team: { archivedAt: null },
                    groupMemberships: { some: { teamGroupId: grant.teamGroupId, ...membershipHorizonWhere(grant.effectiveAt!), group: { archivedAt: null } } },
                } } });
            }
        }
    }
    return { status: "active", OR: sources };
}
