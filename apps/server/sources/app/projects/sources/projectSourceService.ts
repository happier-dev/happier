import { isDeepStrictEqual } from 'node:util';
import { hasProjectSourceOwnerContinuityInTx } from './projectSourceOwnerContinuity';
import { createHash } from 'node:crypto';
import { z } from 'zod/mini';
import * as privacyKit from 'privacy-kit';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
    ProjectSourceGrantV1Schema, ProjectSourceOwnerV1Schema, ProjectSourceV1StoredSchema, PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
    ProjectSourcesCreateInputV1Schema, ProjectSourcesReadInputV1Schema,
    ProjectSourcesUpdateInputV1Schema, ProjectSourcesDeleteInputV1Schema, ProjectSourcesListInputV1Schema,
    type ProjectSourceV1, type ProjectSourceListItemV1, type ProjectSourceOwnerV1, type ProjectSourceGrantV1, type SourceAttachmentV1,
    type ProjectSourceAttachmentIntentV1, type ProjectSourcesFailureV1,
    type ProjectSourcesReadOutputV1, type ProjectSourcesListOutputV1, type ProjectSourcesDeleteOutputV1,
    type ProjectSourcePublicationPatchV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { isProjectSourceAttachmentKindV1 } from '@happier-dev/protocol/projects/sources/projectSourceAttachmentAdmissionV1';
import { applyPromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { resourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, lockPostgresRepeatKeyInTx, saveRepeatKey } from '@/storage/queue/repeatKey';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { readArtifactHeaderForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { retireDeploymentPreviewsForSourceReplacementInTx } from '@/app/deployments/deploymentPreviewRetirement';
import {
    resolveTeamActorContextsInTx, qualifyTeamOperationAuthenticationsInTx,
    type TeamOperationAuthenticationContext, type TeamActorContext,
} from '@/app/teams/actorContext';
import { projectSourcePrincipalCanRead, projectSourceAdmitsGroup } from './projectSourcePrincipalAccess';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE, isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { resolveShareAccountSubjectsInTx } from '@/app/teams/shareEligibility';
import {
    resolveEffectiveTeamGroupIdsForAccountInTeamsInTx, EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE,
} from '@/app/teams/groups/effectiveGroupMembership';
import { projectSourceAccessCaptureSql, resolveProjectSourceAccessFromCapture, type ProjectSourceAccessCapture } from './projectSourceReadCapture';
import { lockProjectSourceForDefaultsInTx } from './projectSourceWriteLock';
import { readProjectSourceSessionDefaultsInTx, prepareProjectSourceSessionDefaultsInTx } from './projectSourceSessionDefaults';
import { projectSourceListFiltersSql, resolveProjectSourceQueryScopeInTx } from './projectSourceQuery';
import { mayPublishProjectSourceSetupArtifact } from './projectSourceContentReferences';

const storedAudience = createStoredReadSchema(z.array(ProjectSourceGrantV1Schema));
type Authentication = Partial<TeamOperationAuthenticationContext>;
export type ProjectSourceRow = NonNullable<Awaited<ReturnType<Tx['projectSource']['findUnique']>>>;
type SourceRow = ProjectSourceRow;
// Canonically admitted DTOs contain JSON only; remove optional undefined fields at the DB boundary.
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const unavailable = (): ProjectSourcesFailureV1 & { error: 'source_unavailable' } => ({ ok: false, error: 'source_unavailable' });
const invalid = (): ProjectSourcesFailureV1 & { error: 'source_invalid' } => ({ ok: false, error: 'source_invalid' });
const denied = (): ProjectSourcesFailureV1 & { error: 'source_access_denied' } => ({ ok: false, error: 'source_access_denied' });

export function sourceFromRow(row: SourceRow) {
    return ProjectSourceV1StoredSchema.safeParse({
        id: row.id, revision: row.revision, name: row.name,
        ...(row.repository === null ? {} : { repository: row.repository }),
        ...(row.defaultRef === null ? {} : { defaultRef: row.defaultRef }),
        ...(row.subdir === null ? {} : { subdir: row.subdir }),
        audience: row.audience, owner: row.owner ?? { kind: 'account', accountId: row.createdByAccountId },
        createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), attachments: row.attachments,
    });
}

export function sourceOwner(source: Pick<ProjectSourceV1, 'owner' | 'createdByAccountId'>): ProjectSourceOwnerV1 {
    return source.owner ?? { kind: 'account', accountId: source.createdByAccountId };
}

function ownerFromRow(row: SourceRow) {
    return ProjectSourceOwnerV1Schema.safeParse(row.owner ?? { kind: 'account', accountId: row.createdByAccountId });
}

/** Current membership and credential owners decide; Home governance never grants Source management. */
export async function resolveProjectSourceAdmissionInTx(tx: Tx, actorAccountId: string, grants: readonly ProjectSourceGrantV1[], authentication: Authentication,
    owners: readonly ProjectSourceOwnerV1[] = [], admittedTeamActors: readonly TeamActorContext[] = []) {
    const admittedByTeam = new Map(admittedTeamActors.map(context => [context.team.id, context]));
    const accountStatus = admittedTeamActors[0] ? admittedTeamActors[0].accountStatus
        : (await tx.account.findUnique({ where: { id: actorAccountId }, select: { status: true } }))?.status;
    const active = accountStatus === 'active';
    const teamIds = [...new Set([...grants.map(grant => grant.principal), ...owners]
        .flatMap(principal => principal.kind === 'account' ? [] : [principal.teamId]))];
    const contexts = new Map(await resolveTeamActorContextsInTx(tx, {
        teamIds: teamIds.filter(teamId => !admittedByTeam.has(teamId)), actorAccountId,
    }));
    for (const teamId of teamIds) {
        const admitted = admittedByTeam.get(teamId);
        if (admitted) contexts.set(teamId, admitted);
    }
    const qualified = await qualifyTeamOperationAuthenticationsInTx(tx, { contexts: [...contexts.values()], ...authentication });
    const groupIds = await resolveEffectiveTeamGroupIdsForAccountInTeamsInTx(tx, { teamIds, accountId: actorAccountId });
    const groups = new Map([...groupIds].map(([teamId, ids]) => [teamId, new Set(ids)]));
    return composeProjectSourceAdmission({ actorAccountId, active, contexts, qualified, groups });
}

/** The Source policy consumes canonical Team, credential and Group decisions, regardless of the read shape. */
export function composeProjectSourceAdmission(input: Readonly<{
    actorAccountId: string;
    active: boolean;
    contexts: ReadonlyMap<string, TeamActorContext>;
    qualified: ReadonlyMap<string, Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>>;
    groups: ReadonlyMap<string, ReadonlySet<string>>;
}>) {
    const { actorAccountId, active, contexts, qualified, groups } = input;
    const admittedTeam = (teamId: string) => {
        const context = qualified.get(teamId)?.ok === true ? contexts.get(teamId) : undefined;
        return context?.membership && isEffectiveTeamMembership({ accountStatus: context.accountStatus,
            membershipStatus: context.membership.status, teamArchivedAt: context.team.archivedAt }) ? context : undefined;
    };
    const canManageOwner = (owner: ProjectSourceOwnerV1 | undefined) => active && owner !== undefined
        && (owner.kind === 'account' ? owner.accountId === actorAccountId
            : admittedTeam(owner.teamId)?.teamCapabilities.manageSettings === true);
    const canReadPrincipal = (principal: ProjectSourceGrantV1['principal']) => projectSourcePrincipalCanRead(principal, actorAccountId, teamId => {
        const context = admittedTeam(teamId);
        return context?.membership ? { role: context.membership.role, groupIds: groups.get(teamId) ?? new Set<string>() } : undefined;
    });
    return {
        active,
        canManageOwner,
        canManage(owner: ProjectSourceOwnerV1, audience: readonly ProjectSourceGrantV1[]) {
            return active && (canManageOwner(owner) || audience.some(({ principal }) => principal.kind !== 'account'
                && admittedTeam(principal.teamId)?.teamCapabilities.manageSettings === true));
        },
        canRead(owner: ProjectSourceOwnerV1 | undefined, audience: readonly ProjectSourceGrantV1[]) {
            return active && ((owner !== undefined && canReadPrincipal(owner)) || audience.some(({ principal }) => canReadPrincipal(principal)));
        },
        canDeployMember(owner: ProjectSourceOwnerV1, audience: readonly ProjectSourceGrantV1[]) {
            return active && [owner, ...audience.map(grant => grant.principal)].some(principal => canReadPrincipal(principal)
                && (principal.kind === 'account' || isTeamPrincipalRoleV1(admittedTeam(principal.teamId)?.membership?.role ?? 'guest')));
        },
        admittedTeam,
        effectivePrincipals(owner: ProjectSourceOwnerV1, audience: readonly ProjectSourceGrantV1[]) {
            if (!active) return [];
            const principals = [owner, ...audience.map(grant => grant.principal)];
            const scopedTeamIds = [...new Set(principals.flatMap(principal => principal.kind === 'account' ? [] : [principal.teamId]))];
            // The batch shares current membership reads, never another Source's scope.
            return [{ kind: 'account' as const, accountId: actorAccountId },
                ...scopedTeamIds.flatMap(teamId => principals.some(principal => principal.kind === 'team' && principal.teamId === teamId)
                    && canReadPrincipal({ kind: 'team', teamId }) ? [{ kind: 'team' as const, teamId }] : []),
                ...scopedTeamIds.flatMap(teamId => admittedTeam(teamId) ? [...(groups.get(teamId) ?? [])]
                    .filter(groupId => projectSourceAdmitsGroup(principals, { teamId, id: groupId }))
                    .map(groupId => ({ kind: 'group' as const, teamId, groupId })) : [])];
        },
    };
}

/** Accounts pass the one share-eligibility rule (Accounts already in the previous audience are existing shares);
 * Team and Group principals additionally need the actor's Team settings authority. */
async function validateAudienceInTx(tx: Tx, actorAccountId: string, audience: readonly ProjectSourceGrantV1[], authentication: Authentication,
    previousAudience: readonly ProjectSourceGrantV1[] = []): Promise<boolean> {
    const admission = await resolveProjectSourceAdmissionInTx(tx, actorAccountId, audience, authentication);
    if (!admission.active) return false;
    const accountIds = (principals: readonly ProjectSourceGrantV1[]) => principals.flatMap(({ principal }) =>
        principal.kind === 'account' && principal.accountId !== actorAccountId ? [principal.accountId] : []);
    const retained = new Set(accountIds(previousAudience));
    const requested = accountIds(audience);
    const resolutions = await Promise.all([false, true].map(hasExistingGrant => resolveShareAccountSubjectsInTx(tx, {
        actorAccountId, resourceOwnerAccountId: actorAccountId, hasExistingGrant,
        subjectAccountIds: requested.filter(accountId => retained.has(accountId) === hasExistingGrant),
    })));
    if (!resolutions.flat().every(resolution => resolution.ok)) return false;
    for (const { principal } of audience) {
        if (principal.kind !== 'account') {
            if (admission.admittedTeam(principal.teamId)?.teamCapabilities.manageSettings !== true) return false;
            if (principal.kind === 'group' && !(await tx.teamGroup.findFirst({ where: { id: principal.groupId, teamId: principal.teamId, archivedAt: null }, select: { id: true } }))) return false;
        }
    }
    return true;
}

/** One reader census, with a result for every input (including old/new versions of the same Source).
 * It equals read admission: active Accounts, non-guest Team members, members of granted Groups only.
 * Change notices and E2EE recipient wraps both consume it, so neither reaches someone reads refuse. */
export async function resolveProjectSourceAudiencesInTx(tx: Tx, sources: readonly ProjectSourceV1[]): Promise<string[][]> {
    const accountIds = new Set<string>();
    const teamIds = new Set<string>();
    const groups = new Map<string, Extract<ProjectSourceGrantV1['principal'], { kind: 'group' }>>();
    for (const source of sources) for (const principal of [sourceOwner(source), ...source.audience.map(grant => grant.principal)]) {
        if (principal.kind === 'account') accountIds.add(principal.accountId);
        else if (principal.kind === 'team') teamIds.add(principal.teamId);
        else groups.set(JSON.stringify([principal.teamId, principal.groupId]), principal);
    }
    const teamAccounts = new Map<string, Set<string>>();
    for (const ids of portableQueryChunks({ values: [...teamIds], bindingsPerValue: 1, fixedBindings: 3 /* two statuses, offset */ })) {
        const members = await tx.teamMembership.findMany({ where: { ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE, teamId: { in: [...ids] } },
            select: { accountId: true, teamId: true, role: true } });
        for (const member of members) {
            if (!isTeamPrincipalRoleV1(member.role)) continue;
            accountIds.add(member.accountId);
            const accounts = teamAccounts.get(member.teamId) ?? new Set<string>();
            accounts.add(member.accountId);
            teamAccounts.set(member.teamId, accounts);
        }
    }
    const groupAccounts = new Map<string, Set<string>>();
    for (const principals of portableQueryChunks({ values: [...groups.values()], bindingsPerValue: 2,
        fixedBindings: 3 /* two effective-membership statuses and offset */ })) {
        const members = await tx.teamGroupMembership.findMany({ where: { ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE,
            OR: principals.map(principal => ({ teamGroupId: principal.groupId, group: { teamId: principal.teamId } })),
        }, select: { teamGroupId: true, group: { select: { teamId: true } }, teamMembership: { select: { accountId: true } } } });
        for (const member of members) {
            accountIds.add(member.teamMembership.accountId);
            const key = JSON.stringify([member.group.teamId, member.teamGroupId]);
            const accounts = groupAccounts.get(key) ?? new Set<string>();
            accounts.add(member.teamMembership.accountId);
            groupAccounts.set(key, accounts);
        }
    }
    const activeAccountIds: string[] = [];
    for (const ids of portableQueryChunks({ values: [...accountIds], bindingsPerValue: 1, fixedBindings: 2 /* status, offset */ })) {
        const active = await tx.account.findMany({ where: { id: { in: [...ids] }, status: 'active' }, select: { id: true } });
        activeAccountIds.push(...active.map(account => account.id));
    }
    const active = new Set(activeAccountIds);
    return sources.map(source => {
        const audience = new Set<string>();
        for (const principal of [sourceOwner(source), ...source.audience.map(grant => grant.principal)]) {
            const accounts = principal.kind === 'account' ? [principal.accountId]
                : principal.kind === 'team' ? teamAccounts.get(principal.teamId) ?? []
                    : groupAccounts.get(JSON.stringify([principal.teamId, principal.groupId])) ?? [];
            for (const accountId of accounts) if (active.has(accountId)) audience.add(accountId);
        }
        return [...audience];
    });
}

/** Source ownership and explicit grants share one current audience census for Source-owned records. */
export async function resolveProjectSourceAudienceInTx(tx: Tx, sources: readonly ProjectSourceV1[]): Promise<string[]> {
    return [...new Set((await resolveProjectSourceAudiencesInTx(tx, sources)).flat())];
}

/** Content-free AccountChange invalidation reuses the existing commit-boundary publisher. */
async function publishInTx(tx: Tx, sources: readonly ProjectSourceV1[]): Promise<void> {
    await markAccountsChanged(tx, { accountIds: await resolveProjectSourceAudienceInTx(tx, sources), entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 });
}

export interface ProjectSourceAccess {
    readonly ok: true;
    readonly source: ProjectSourceV1;
    readonly owner: ProjectSourceOwnerV1;
    readonly canManage: boolean;
    readonly canManageOwner: boolean;
    readonly canDeployMember: boolean;
    /** The actor's own identity plus the Source-scoped Teams and Groups it currently belongs to. */
    readonly effectivePrincipals: readonly PrincipalRefV1[];
}
export type ProjectSourceAccessResult = ProjectSourceAccess | Readonly<{ ok: false; failure: ReturnType<typeof unavailable> | ReturnType<typeof invalid> }>;

/** Singleton and set readers share one current Account, Team and credential census. */
async function admitSourceRowsInTx(tx: Tx, actorAccountId: string, rows: readonly SourceRow[], authentication: Authentication) {
    const result = new Map<string, ProjectSourceAccessResult>();
    if (!rows.length) return result;
    const entries = rows.map(row => {
        const audience = storedAudience.safeParse(row.audience);
        const parsedOwner = ownerFromRow(row);
        return { row, grants: audience.success ? audience.data : [], owner: parsedOwner.success ? parsedOwner.data : undefined };
    });
    const admission = await resolveProjectSourceAdmissionInTx(tx, actorAccountId, entries.flatMap(entry => entry.grants), authentication,
        entries.flatMap(entry => entry.owner ? [entry.owner] : []));
    return admitProjectSourceEntries(entries, admission);
}

/** Scalar, portable set and captured PostgreSQL reads evaluate the identical stored Source policy. */
export function admitProjectSourceRows(rows: readonly ProjectSourceRow[], admission: ReturnType<typeof composeProjectSourceAdmission>) {
    const entries = rows.map(row => {
        const audience = storedAudience.safeParse(row.audience);
        const parsedOwner = ownerFromRow(row);
        return { row, grants: audience.success ? audience.data : [], owner: parsedOwner.success ? parsedOwner.data : undefined };
    });
    return admitProjectSourceEntries(entries, admission);
}

function admitProjectSourceEntries(entries: readonly Readonly<{ row: ProjectSourceRow; grants: readonly ProjectSourceGrantV1[];
    owner: ProjectSourceOwnerV1 | undefined }>[], admission: ReturnType<typeof composeProjectSourceAdmission>) {
    const result = new Map<string, ProjectSourceAccessResult>();
    for (const { row, grants, owner } of entries) {
        if (!admission.canRead(owner, grants)) { result.set(row.id, { ok: false, failure: unavailable() }); continue; }
        const parsed = sourceFromRow(row);
        if (!parsed.success) { result.set(row.id, { ok: false, failure: invalid() }); continue; }
        const currentOwner = sourceOwner(parsed.data);
        const teamIds = new Set([currentOwner, ...grants.map(grant => grant.principal)]
            .flatMap(principal => principal.kind === 'account' ? [] : [principal.teamId]));
        const audienceTeams = [...teamIds].flatMap(teamId => {
            const team = admission.admittedTeam(teamId)?.team;
            return team ? [{ teamId: team.id, name: team.name }] : [];
        });
        result.set(row.id, { ok: true, source: { ...parsed.data, audienceTeams }, owner: currentOwner, canManage: admission.canManage(currentOwner, grants),
            canManageOwner: admission.canManageOwner(currentOwner), canDeployMember: admission.canDeployMember(currentOwner, grants),
            effectivePrincipals: admission.effectivePrincipals(currentOwner, grants) });
    }
    return result;
}

export async function resolveProjectSourceAccessInTx(tx: Tx, actorAccountId: string, sourceId: string, authentication: Authentication = {},
    options: Readonly<{ includeDeleted?: boolean }> = {}) {
    const row = await tx.projectSource.findUnique({ where: { id: sourceId, ...(options.includeDeleted ? {} : { deletedAt: null }) } });
    if (!row) return { ok: false as const, failure: unavailable() };
    return (await admitSourceRowsInTx(tx, actorAccountId, [row], authentication)).get(sourceId)
        ?? { ok: false as const, failure: unavailable() };
}

/** Exact demand only; transport chunks do not repeat the Source policy census. */
export async function resolveProjectSourcesAccessInTx(tx: Tx, actorAccountId: string, sourceIds: readonly string[],
    authentication: Authentication = {},
    options: Readonly<{ includeDeleted?: boolean }> = {},
): Promise<ReadonlyMap<string, ProjectSourceAccessResult>> {
    if (sourceIds.length === 0) return new Map();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'postgres' || provider === 'pglite') {
        const ids = prismaRuntime.sql`SELECT s."id" FROM "ProjectSource" s
            WHERE s."id" IN (SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(sourceIds)])}::jsonb))
            ${options.includeDeleted ? prismaRuntime.empty : prismaRuntime.sql`AND s."deletedAt" IS NULL`}`;
        const rows = await tx.$queryRaw<Array<{ capture: ProjectSourceAccessCapture }>>(prismaRuntime.sql`
            SELECT ${projectSourceAccessCaptureSql({ actorAccountId: prismaRuntime.sql`${actorAccountId}`, sourceIds: ids,
                env: authentication.env })} AS capture`);
        return resolveProjectSourceAccessFromCapture(tx, { actorAccountId, authentication, capture: rows[0]!.capture });
    }
    const rows: SourceRow[] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(sourceIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        rows.push(...await tx.projectSource.findMany({ where: { id: { in: [...ids] }, ...(options.includeDeleted ? {} : { deletedAt: null }) } }));
    }
    return admitSourceRowsInTx(tx, actorAccountId, rows, authentication);
}

/** Internal Source facts only; installed consumers separately prove the owner's Machine grant. */
export async function readProjectSourceCustodyInTx(tx: Tx, sourceId: string) {
    return (await readProjectSourcesCustodyInTx(tx, [sourceId], { includeDeleted: true })).get(sourceId) ?? null;
}

/** Exact internal parent facts; this does not grant the caller access to a Source. */
export async function readProjectSourcesCustodyInTx(tx: Tx, sourceIds: readonly string[],
    options: Readonly<{ includeDeleted?: boolean }> = {},
) {
    const result = new Map<string, { source: ProjectSourceV1; owner: ProjectSourceOwnerV1 }>();
    for (const ids of portableQueryChunks({ values: [...new Set(sourceIds)], bindingsPerValue: 1, fixedBindings: 1 })) {
        const rows = await tx.projectSource.findMany({ where: { id: { in: [...ids] }, ...(options.includeDeleted ? {} : { deletedAt: null }) } });
        for (const row of rows) {
            const source = sourceFromRow(row);
            if (source.success) result.set(row.id, { source: source.data, owner: sourceOwner(source.data) });
        }
    }
    return result;
}

/** Internal ownership fact only; this does not admit an Account to the Source. */
export async function readProjectSourceOwnerInTx(tx: Tx, sourceId: string): Promise<ProjectSourceOwnerV1 | null> {
    return (await readProjectSourceCustodyInTx(tx, sourceId))?.owner ?? null;
}

function exactRef(a: SourceAttachmentV1, b: SourceAttachmentV1, serverId: string): boolean {
    if (a.purpose !== b.purpose) return false;
    if (a.purpose === 'context' && b.purpose === 'context') return a.entry.id === b.entry.id;
    if (a.purpose === 'context' || b.purpose === 'context' || a.purpose !== b.purpose) return false;
    return a.ref.artifactId === b.ref.artifactId && a.ref.kind === b.ref.kind
        && (a.ref.serverId ?? serverId) === (b.ref.serverId ?? serverId);
}

async function attachAdmissionInTx(tx: Tx, actorAccountId: string, sourceServerId: string, attachment: SourceAttachmentV1): Promise<ProjectSourcesFailureV1 | null> {
    if (attachment.purpose === 'context' && attachment.entry.placement !== 'system_append') return invalid();
    const ref = attachment.purpose === 'context' ? attachment.entry.ref : attachment.ref;
    // Qualified foreign refs are admitted by the canonical Account-side Artifact reader, like opaque E2EE kind semantics.
    // This transaction grants no document rights, and a local same-id Artifact is never a substitute for another Home.
    if (ref.serverId !== undefined && ref.serverId !== sourceServerId) return attachment.purpose === 'setup'
        ? { ok: false, error: 'artifact_unavailable' } : null;
    const opened = await readArtifactHeaderForCallerInTx(tx, { actorAccountId, artifactId: ref.artifactId });
    if (!opened.ok) return { ok: false, error: 'artifact_unavailable' };
    // Read custody cannot widen another person's executable content through a Source.
    if (attachment.purpose === 'setup' && !mayPublishProjectSourceSetupArtifact(actorAccountId, opened.artifact.ownerAccountId))
        return { ok: false, error: 'artifact_unavailable' };
    if (opened.artifact.encryptionMode === 'plain') {
        const header: unknown = decodePlainArtifactStoredContent(privacyKit.encodeBase64(opened.artifact.header));
        if (!isProjectSourceAttachmentKindV1(attachment.purpose, ref.kind, header)) return { ok: false, error: 'artifact_wrong_kind' };
    }
    // E2EE kind admission belongs to the Account-side Action client; recheck access and mode without opening ciphertext.
    return null;
}

async function applyAttachmentInTx(tx: Tx, actorAccountId: string, serverId: string, source: ProjectSourceV1, intent: ProjectSourceAttachmentIntentV1) {
    const attachments = [...(source.attachments ?? [])];
    if (intent.kind === 'attach') {
        const failure = await attachAdmissionInTx(tx, actorAccountId, serverId, intent.attachment);
        if (failure) return { ok: false as const, failure };
        const existing = attachments.find(attachment => exactRef(attachment, intent.attachment, serverId));
        if (existing?.purpose === 'context' && !isDeepStrictEqual(existing, intent.attachment)) return { ok: false as const, failure: invalid() };
        if (intent.attachment.purpose === 'onboarding_task') {
            return { ok: true as const, attachments: existing ? attachments
                : [...attachments.filter(item => item.purpose !== 'onboarding_task'), intent.attachment] };
        }
        if (intent.attachment.purpose === 'setup') {
            return { ok: true as const, attachments: [...attachments.filter(item => item.purpose !== 'setup'), intent.attachment] };
        }
        if (!existing) attachments.push(intent.attachment);
    } else if (intent.kind === 'detach') {
        return { ok: true as const, attachments: attachments.filter(attachment => intent.purpose === 'context'
            ? !(attachment.purpose === 'context' && attachment.entry.id === intent.attachmentId)
            : !(attachment.purpose === intent.purpose
                && attachment.ref.artifactId === intent.ref.artifactId
                && attachment.ref.kind === intent.ref.kind
                && (attachment.ref.serverId ?? serverId) === (intent.ref.serverId ?? serverId))) };
    } else {
        const index = attachments.findIndex(attachment => attachment.purpose === 'context' && attachment.entry.id === intent.attachmentId);
        const attachment = attachments[index];
        if (index < 0 || attachment?.purpose !== 'context') return { ok: false as const, failure: invalid() };
        if (intent.kind === 'budget' || intent.kind === 'set_enabled') {
            const applied = applyPromptStackIntentV1({ promptStack: [attachment.entry] }, intent.kind === 'budget'
                ? { kind: 'set_budget', entryId: intent.attachmentId, maxChars: intent.maxChars }
                : { kind: 'set_enabled', entryId: intent.attachmentId, enabled: intent.enabled });
            if (!applied.ok) return { ok: false as const, failure: invalid() };
            attachments[index] = { ...attachment, entry: applied.row.promptStack[0]! };
        } else {
            if (intent.beforeId === intent.attachmentId) return { ok: true as const, attachments };
            if (intent.beforeId !== null && !attachments.some(item => item.purpose === 'context' && item.entry.id === intent.beforeId)) return { ok: false as const, failure: invalid() };
            attachments.splice(index, 1);
            const destination = intent.beforeId === null ? attachments.length : attachments.findIndex(item => item.purpose === 'context' && item.entry.id === intent.beforeId);
            attachments.splice(destination, 0, attachment);
        }
    }
    return { ok: true as const, attachments };
}

/** The Source owner also admits an intended owner before a Source exists. */
export async function canManageProjectSourceOwnerInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1,
    authentication: Authentication = {}): Promise<boolean> {
    return (await resolveProjectSourceAdmissionInTx(tx, actorAccountId, [], authentication, [owner])).canManageOwner(owner);
}

/** Create metadata once per actor's intent; replay reads current admitted state, never duplicates an unavailable row. */
export async function createProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesReadOutputV1> {
    const parsed = ProjectSourcesCreateInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const audience = parsed.data.audience ?? [];
    const owner = parsed.data.owner ?? { kind: 'account' as const, accountId: actorAccountId };
    const requestKey = `projects.sources.create:${actorAccountId}:${parsed.data.requestKey}`;
    await lockPostgresRepeatKeyInTx(tx, requestKey);
    const actor = await tx.account.findUnique({ where: { id: actorAccountId }, select: { status: true } });
    if (actor?.status !== 'active') return denied();
    const digestInput: unknown[] = [parsed.data.serverId, parsed.data.name,
        parsed.data.repository ?? null, parsed.data.defaultRef ?? null, parsed.data.subdir ?? null, audience];
    if (owner.kind !== 'account' || owner.accountId !== actorAccountId) digestInput.push(owner);
    const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('base64url');
    const now = await readTransactionDatabaseTime(tx);
    const recorded = await fetchRepeatKey(tx, requestKey, now);
    if (recorded !== null) {
        const [recordedDigest, sourceId] = recorded.split(':');
        if (recordedDigest !== digest || !sourceId) return { ok: false, error: 'source_conflict' };
        const replay = await resolveProjectSourceAccessInTx(tx, actorAccountId, sourceId, authentication);
        return replay.ok ? { ok: true, source: replay.source, canManage: replay.canManage, canManageSessionDefaults: replay.canManageOwner }
            : { ok: false, error: 'source_conflict' };
    }
    if (!(await validateAudienceInTx(tx, actorAccountId, audience, authentication))) return denied();
    if (!await canManageProjectSourceOwnerInTx(tx, actorAccountId, owner, authentication)) return denied();
    const row = await tx.projectSource.create({ data: { createdByAccountId: actorAccountId,
        name: parsed.data.name, repository: parsed.data.repository === undefined ? prismaRuntime.DbNull : json(parsed.data.repository),
        owner: json(owner), defaultRef: parsed.data.defaultRef,
        subdir: parsed.data.subdir, audience: json(audience), attachments: [] } });
    const source = sourceFromRow(row);
    if (!source.success) throw new Error('Canonical Source write failed stored admission');
    await saveRepeatKey(tx, requestKey, `${digest}:${row.id}`, defaultRepeatKeyExpiresAt(now));
    await publishInTx(tx, [source.data]);
    return { ok: true, source: source.data, canManage: true, canManageSessionDefaults: true };
}

/** Read disclosure is admitted from current Account, Team and Group lifetimes. */
export async function readProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<Extract<ProjectSourcesReadOutputV1, { ok: true }> | (ProjectSourcesFailureV1 & { error: 'source_invalid' | 'source_unavailable' })> {
    const parsed = ProjectSourcesReadInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const loaded = await resolveProjectSourceAccessInTx(tx, actorAccountId, parsed.data.sourceId, authentication);
    if (!loaded.ok) return loaded.failure;
    const defaults = await readProjectSourceSessionDefaultsInTx(tx, loaded.source.id);
    return defaults.ok ? { ...defaults, source: loaded.source, canManage: loaded.canManage,
        canManageSessionDefaults: loaded.canManageOwner } : defaults;
}

/** Source writes and key preparation admit the same prospective audience and owner. */
export async function prepareProjectSourcePublicationInTx(tx: Tx, actorAccountId: string,
    loaded: Readonly<{ source: ProjectSourceV1; owner: ProjectSourceOwnerV1; canManage: boolean; canManageOwner: boolean }>,
    patch: ProjectSourcePublicationPatchV1, authentication: Authentication = {},
): Promise<Readonly<{ ok: true; source: ProjectSourceV1; owner: ProjectSourceOwnerV1 }> | ProjectSourcesFailureV1> {
    if (!loaded.canManage) return denied();
    const source = loaded.source;
    if (patch.owner && !isDeepStrictEqual(patch.owner, loaded.owner)) {
        if (!loaded.canManageOwner || loaded.owner.kind !== 'account' || patch.owner.kind !== 'team') return denied();
        const admission = await resolveProjectSourceAdmissionInTx(tx, actorAccountId, patch.audience ?? source.audience, authentication, [patch.owner]);
        if (!admission.canManageOwner(patch.owner)) return denied();
    }
    if (patch.audience && !(await validateAudienceInTx(tx, actorAccountId, patch.audience, authentication, source.audience))) return denied();
    const next = { ...source, ...(patch.owner === undefined ? {} : { owner: patch.owner }),
        ...(patch.audience === undefined ? {} : { audience: patch.audience }) };
    return { ok: true, source: next, owner: sourceOwner(next) };
}

/** Revision CAS protects metadata and exact attachment intents, never document rights or bytes. */
export async function updateProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesReadOutputV1> {
    const parsed = ProjectSourcesUpdateInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const loaded = await resolveProjectSourceAccessInTx(tx, actorAccountId, parsed.data.sourceId, authentication);
    if (!loaded.ok) return loaded.failure;
    if (!loaded.canManage) return denied();
    const source = loaded.source;
    const patch = parsed.data.patch;
    // Project Session defaults belong to the Source owner side (OWNER-RULINGS ~19:15Z); audience admins only read them.
    if (patch.sessionDefaults && !loaded.canManageOwner) return denied();
    // Admitted writers only serialize first leaf insertion; the leaf CAS re-reads under this lock.
    if (patch.sessionDefaults) await lockProjectSourceForDefaultsInTx(tx, source.id);
    const metadataEdit = !patch.sessionDefaults || Object.keys(patch).some(key => key !== 'sessionDefaults');
    if (metadataEdit && source.revision !== parsed.data.expectedRevision) return { ok: false, error: 'source_conflict', current: source };
    const previousDefaults = patch.sessionDefaults ? null : await readProjectSourceSessionDefaultsInTx(tx, source.id);
    if (previousDefaults && !previousDefaults.ok) return previousDefaults;
    const publication = await prepareProjectSourcePublicationInTx(tx, actorAccountId, loaded, patch, authentication);
    if (!publication.ok) return publication;
    const next: ProjectSourceV1 = { ...publication.source, ...(patch.name === undefined ? {} : { name: patch.name }) };
    if (patch.repository !== undefined) { delete next.repository; if (patch.repository !== null) next.repository = patch.repository; }
    if (patch.defaultRef !== undefined) { delete next.defaultRef; if (patch.defaultRef !== null) next.defaultRef = patch.defaultRef; }
    if (patch.subdir !== undefined) { delete next.subdir; if (patch.subdir !== null) next.subdir = patch.subdir; }
    if (patch.attachment) {
        const applied = await applyAttachmentInTx(tx, actorAccountId, parsed.data.serverId, source, patch.attachment);
        if (!applied.ok) return applied.failure;
        next.attachments = applied.attachments;
    }
    const changed = !isDeepStrictEqual(source, next);
    const defaults = patch.sessionDefaults ? await prepareProjectSourceSessionDefaultsInTx(tx, {
        sourceId: source.id, patch: patch.sessionDefaults,
        audience: async () => (await resolveProjectSourceAudiencesInTx(tx, [next]))[0] ?? [],
    }) : null;
    if (defaults && !defaults.ok) return defaults;
    if (!changed) {
        if (defaults?.ok && defaults.write) { await defaults.write(); await publishInTx(tx, [source]); }
        const leaf = defaults?.ok ? { ok: true as const, sessionDefaults: defaults.sessionDefaults }
            : previousDefaults!;
        return { ...leaf, source, canManage: loaded.canManage, canManageSessionDefaults: loaded.canManageOwner };
    }
    const nextOwner = sourceOwner(next);
    const ownerChanged = !isDeepStrictEqual(loaded.owner, nextOwner);
    if (ownerChanged
        && !await hasProjectSourceOwnerContinuityInTx(tx, actorAccountId, { source: next, owner: nextOwner })) {
        return { ok: false, error: 'source_conflict', current: source };
    }
    const result = await tx.projectSource.updateMany({ where: { id: source.id, revision: source.revision }, data: {
        name: next.name, repository: next.repository === undefined ? prismaRuntime.DbNull : json(next.repository),
        owner: json(nextOwner), defaultRef: next.defaultRef ?? null,
        subdir: next.subdir ?? null, audience: json(next.audience), attachments: json(next.attachments ?? []),
        ...(changed ? { revision: { increment: 1 } } : {}),
    } });
    if (result.count !== 1) {
        const current = await resolveProjectSourceAccessInTx(tx, actorAccountId, source.id, authentication);
        return current.ok ? { ok: false, error: 'source_conflict', current: current.source } : current.failure;
    }
    if (!isDeepStrictEqual(source.repository, next.repository)) {
        // Cleanup refusal must unwind this CAS, not commit a partial replacement.
        await retireDeploymentPreviewsForSourceReplacementInTx(tx, { projectSourceId: source.id });
    }
    if (changed) { next.revision++; await publishInTx(tx, [source, next]); }
    if (defaults?.ok && defaults.write) await defaults.write();
    const admission = await resolveProjectSourceAdmissionInTx(tx, actorAccountId, next.audience, authentication, [nextOwner]);
    const leaf = defaults?.ok ? { ok: true as const, sessionDefaults: defaults.sessionDefaults }
        : previousDefaults!;
    return { ...leaf, source: next, canManage: admission.canManage(nextOwner, next.audience),
        canManageSessionDefaults: admission.canManageOwner(nextOwner) };
}

/** Tombstone metadata uniformly; retained Environment and receipt references keep their identity. */
export async function deleteProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<Extract<ProjectSourcesDeleteOutputV1, { ok: true }> | (ProjectSourcesFailureV1 & { error: 'source_invalid' | 'source_unavailable' | 'source_access_denied' | 'source_conflict' })> {
    const parsed = ProjectSourcesDeleteInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const loaded = await resolveProjectSourceAccessInTx(tx, actorAccountId, parsed.data.sourceId, authentication);
    if (!loaded.ok) return loaded.failure;
    if (!loaded.canManage) return denied();
    if (loaded.source.revision !== parsed.data.expectedRevision) return { ok: false, error: 'source_conflict', current: loaded.source };
    const result = await tx.projectSource.updateMany({ where: { id: loaded.source.id, revision: parsed.data.expectedRevision, deletedAt: null },
        data: { deletedAt: await readTransactionDatabaseTime(tx) } });
    if (result.count !== 1) {
        const current = await resolveProjectSourceAccessInTx(tx, actorAccountId, loaded.source.id, authentication);
        return current.ok ? { ok: false, error: 'source_conflict', current: current.source } : current.failure;
    }
    await publishInTx(tx, [loaded.source]);
    return { ok: true, sourceId: loaded.source.id, revision: loaded.source.revision };
}

/** Search and coverage are over admitted metadata, not an unfiltered database page. */
export async function listProjectSourcesInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesListOutputV1> {
    const parsed = ProjectSourcesListInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const scope = await resolveProjectSourceQueryScopeInTx(tx, { actorAccountId, sharedWithTeamId: parsed.data.sharedWithTeamId, authentication });
    if (!scope.ok) return scope;
    const table = prismaRuntime.raw(getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? '`ProjectSource`' : '"ProjectSource"');
    const limit = parsed.data.limit === undefined ? prismaRuntime.empty : prismaRuntime.sql`LIMIT ${parsed.data.limit + 1}`;
    const candidates = await tx.$queryRaw<Readonly<{ id: string }>[]>(prismaRuntime.sql`SELECT s.id FROM ${table} s
        WHERE ${scope.where} AND ${projectSourceListFiltersSql(parsed.data)} ORDER BY s.id ASC ${limit}`);
    const complete = parsed.data.limit === undefined || candidates.length <= parsed.data.limit;
    const ids = (complete ? candidates : candidates.slice(0, parsed.data.limit)).map(row => row.id);
    const rows = ids.length ? await tx.projectSource.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }) : [];
    const sources: ProjectSourceListItemV1[] = [];
    for (const row of rows) {
        const source = sourceFromRow(row);
        if (!source.success) return invalid();
        const teamId = parsed.data.sharedWithTeamId;
        const principals = [sourceOwner(source.data), ...source.data.audience.map(grant => grant.principal)];
        const sharedWithTeamScope = teamId ? resourceTeamShareScopeV1({
            team: principals.some(principal => principal.kind === 'team' && principal.teamId === teamId),
            group: principals.some(principal => principal.kind === 'group' && principal.teamId === teamId
                && scope.sharedWithTeamGroupIds.has(principal.groupId)),
        }) : undefined;
        sources.push({ ...source.data, ...(sharedWithTeamScope ? { sharedWithTeamScope } : {}) });
    }
    return { ok: true, sources, coverage: { complete, nextCursor: complete ? null : sources.at(-1)?.id ?? null } };
}
