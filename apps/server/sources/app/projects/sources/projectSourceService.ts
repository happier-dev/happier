import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
    ProjectSourceGrantV1Schema, ProjectSourceV1StoredSchema, PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
    ProjectSourcesCreateInputV1Schema, ProjectSourcesReadInputV1Schema,
    ProjectSourcesUpdateInputV1Schema, ProjectSourcesDeleteInputV1Schema, ProjectSourcesListInputV1Schema,
    type ProjectSourceV1, type ProjectSourceGrantV1, type SourceAttachmentV1,
    type ProjectSourceAttachmentIntentV1, type ProjectSourcesFailureV1,
    type ProjectSourcesReadOutputV1, type ProjectSourcesListOutputV1, type ProjectSourcesDeleteOutputV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { isProjectSourceAttachmentKindV1 } from '@happier-dev/protocol/projects/sources/projectSourceAttachmentAdmissionV1';
import { applyPromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { defaultRepeatKeyExpiresAt, fetchRepeatKey, saveRepeatKey } from '@/storage/queue/repeatKey';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { readArtifactHeaderForCallerInTx } from '@/app/artifacts/artifactAccessService';
import {
    resolveTeamActorContextsInTx, qualifyTeamOperationAuthenticationsInTx,
    type TeamOperationAuthenticationContext,
} from '@/app/teams/actorContext';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import {
    resolveEffectiveTeamGroupIdsForAccountInTx, EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE,
} from '@/app/teams/groups/effectiveGroupMembership';

const storedAudience = createStoredReadSchema(z.array(ProjectSourceGrantV1Schema));
type Authentication = Partial<TeamOperationAuthenticationContext>;
type SourceRow = NonNullable<Awaited<ReturnType<Tx['projectSource']['findUnique']>>>;
// Canonically admitted DTOs contain JSON only; remove optional undefined fields at the DB boundary.
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const unavailable = (): ProjectSourcesFailureV1 => ({ ok: false, error: 'source_unavailable' });
const invalid = (): ProjectSourcesFailureV1 => ({ ok: false, error: 'source_invalid' });
const denied = (): ProjectSourcesFailureV1 => ({ ok: false, error: 'source_access_denied' });

function sourceFromRow(row: SourceRow) {
    return ProjectSourceV1StoredSchema.safeParse({
        id: row.id, revision: row.revision, name: row.name, repository: row.repository,
        ...(row.defaultRef === null ? {} : { defaultRef: row.defaultRef }),
        ...(row.subdir === null ? {} : { subdir: row.subdir }),
        audience: row.audience, createdByAccountId: row.createdByAccountId, attachments: row.attachments,
    });
}

/** Current membership and credential owners decide; Home governance never grants Source management. */
async function admissionInTx(tx: Tx, actorAccountId: string, grants: readonly ProjectSourceGrantV1[], authentication: Authentication) {
    const account = await tx.account.findUnique({ where: { id: actorAccountId }, select: { status: true } });
    const active = account?.status === 'active';
    const teamIds = [...new Set(grants.flatMap(({ principal }) => principal.kind === 'account' ? [] : [principal.teamId]))];
    const contexts = await resolveTeamActorContextsInTx(tx, { teamIds, actorAccountId });
    const qualified = await qualifyTeamOperationAuthenticationsInTx(tx, { contexts: [...contexts.values()], ...authentication });
    const groups = new Map(await Promise.all(teamIds.map(async teamId => [teamId,
        new Set(await resolveEffectiveTeamGroupIdsForAccountInTx(tx, { teamId, accountId: actorAccountId }))] as const)));
    const admittedTeam = (teamId: string) => {
        const context = qualified.get(teamId)?.ok === true ? contexts.get(teamId) : undefined;
        return context?.membership && isEffectiveTeamMembership({ accountStatus: context.accountStatus,
            membershipStatus: context.membership.status, teamArchivedAt: context.team.archivedAt }) ? context : undefined;
    };
    return {
        active,
        canManage(creator: string, audience: readonly ProjectSourceGrantV1[]) {
            return active && (creator === actorAccountId || audience.some(({ principal }) => principal.kind !== 'account'
                && admittedTeam(principal.teamId)?.teamCapabilities.manageSettings === true));
        },
        canRead(creator: string, audience: readonly ProjectSourceGrantV1[]) {
            return active && (creator === actorAccountId || audience.some(({ principal }) => {
                if (principal.kind === 'account') return principal.accountId === actorAccountId;
                const context = admittedTeam(principal.teamId);
                if (context?.teamCapabilities.manageSettings === true) return true;
                if (!context?.membership) return false;
                return principal.kind === 'team' ? isTeamPrincipalRoleV1(context.membership.role)
                    : groups.get(principal.teamId)?.has(principal.groupId) === true;
            }));
        },
        admittedTeam,
    };
}

async function validateAudienceInTx(tx: Tx, actorAccountId: string, audience: readonly ProjectSourceGrantV1[], authentication: Authentication): Promise<boolean> {
    const admission = await admissionInTx(tx, actorAccountId, audience, authentication);
    if (!admission.active) return false;
    for (const { principal } of audience) {
        if (principal.kind === 'account') {
            if (!(await tx.account.findFirst({ where: { id: principal.accountId, status: 'active' }, select: { id: true } }))) return false;
        } else {
            if (admission.admittedTeam(principal.teamId)?.teamCapabilities.manageSettings !== true) return false;
            if (principal.kind === 'group' && !(await tx.teamGroup.findFirst({ where: { id: principal.groupId, teamId: principal.teamId, archivedAt: null }, select: { id: true } }))) return false;
        }
    }
    return true;
}

/** Content-free AccountChange invalidation reuses the existing commit-boundary publisher. */
async function publishInTx(tx: Tx, sources: readonly ProjectSourceV1[]): Promise<void> {
    const accountIds = new Set(sources.map(source => source.createdByAccountId));
    for (const source of sources) for (const { principal } of source.audience) {
        if (principal.kind === 'account') accountIds.add(principal.accountId);
        else if (principal.kind === 'team') {
            const members = await tx.teamMembership.findMany({ where: { teamId: principal.teamId, status: 'active', account: { status: 'active' }, team: { archivedAt: null } }, select: { accountId: true } });
            members.forEach(member => accountIds.add(member.accountId));
        } else {
            const members = await tx.teamGroupMembership.findMany({ where: { ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE, teamGroupId: principal.groupId, group: { teamId: principal.teamId, archivedAt: null } }, select: { teamMembership: { select: { accountId: true } } } });
            members.forEach(member => accountIds.add(member.teamMembership.accountId));
            const administrators = await tx.teamMembership.findMany({ where: { teamId: principal.teamId,
                status: 'active', role: { in: ['owner', 'admin'] }, account: { status: 'active' }, team: { archivedAt: null } }, select: { accountId: true } });
            administrators.forEach(member => accountIds.add(member.accountId));
        }
    }
    const existing = await tx.account.findMany({ where: { id: { in: [...accountIds] } }, select: { id: true } });
    await markAccountsChanged(tx, { accountIds: existing.map(account => account.id), entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 });
}

async function loadInTx(tx: Tx, actorAccountId: string, sourceId: string, authentication: Authentication) {
    const row = await tx.projectSource.findUnique({ where: { id: sourceId } });
    if (!row) return { ok: false as const, failure: unavailable() };
    const audience = storedAudience.safeParse(row.audience);
    const grants = audience.success ? audience.data : [];
    const admission = await admissionInTx(tx, actorAccountId, grants, authentication);
    if (!admission.canRead(row.createdByAccountId, grants)) return { ok: false as const, failure: unavailable() };
    const parsed = sourceFromRow(row);
    if (!parsed.success) return { ok: false as const, failure: invalid() };
    return { ok: true as const, source: parsed.data, canManage: admission.canManage(row.createdByAccountId, grants) };
}

function exactRef(a: SourceAttachmentV1, b: SourceAttachmentV1, serverId: string): boolean {
    if (a.purpose !== b.purpose) return false;
    if (a.purpose === 'context' && b.purpose === 'context') return a.entry.id === b.entry.id;
    if (a.purpose !== 'dashboard' || b.purpose !== 'dashboard') return false;
    return a.ref.artifactId === b.ref.artifactId && a.ref.kind === b.ref.kind
        && (a.ref.serverId ?? serverId) === (b.ref.serverId ?? serverId);
}

async function attachAdmissionInTx(tx: Tx, actorAccountId: string, sourceServerId: string, attachment: SourceAttachmentV1): Promise<ProjectSourcesFailureV1 | null> {
    if (attachment.purpose === 'context' && attachment.entry.placement !== 'system_append') return invalid();
    const ref = attachment.purpose === 'context' ? attachment.entry.ref : attachment.ref;
    // Qualified foreign refs are admitted by the canonical Account-side Artifact reader, like opaque E2EE kind semantics.
    // This transaction grants no document rights, and a local same-id Artifact is never a substitute for another Home.
    if (ref.serverId !== undefined && ref.serverId !== sourceServerId) return null;
    const opened = await readArtifactHeaderForCallerInTx(tx, { actorAccountId, artifactId: ref.artifactId });
    if (!opened.ok) return { ok: false, error: 'artifact_unavailable' };
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
        if (!existing) attachments.push(intent.attachment);
    } else if (intent.kind === 'detach') {
        return { ok: true as const, attachments: attachments.filter(attachment => intent.purpose === 'context'
            ? !(attachment.purpose === 'context' && attachment.entry.id === intent.attachmentId)
            : !exactRef(attachment, { purpose: 'dashboard', ref: intent.ref }, serverId)) };
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

/** Create metadata once per actor's intent; replay reads current admitted state, never duplicates an unavailable row. */
export async function createProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesReadOutputV1> {
    const parsed = ProjectSourcesCreateInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const audience = parsed.data.audience ?? [];
    const actor = await tx.account.findUnique({ where: { id: actorAccountId }, select: { status: true } });
    if (actor?.status !== 'active') return denied();
    const requestKey = `projects.sources.create:${actorAccountId}:${parsed.data.requestKey}`;
    const digest = createHash('sha256').update(JSON.stringify([parsed.data.serverId, parsed.data.name,
        parsed.data.repository, parsed.data.defaultRef ?? null, parsed.data.subdir ?? null, audience])).digest('base64url');
    const now = await readTransactionDatabaseTime(tx);
    const recorded = await fetchRepeatKey(tx, requestKey, now);
    if (recorded !== null) {
        const [recordedDigest, sourceId] = recorded.split(':');
        if (recordedDigest !== digest || !sourceId) return { ok: false, error: 'source_conflict' };
        const replay = await loadInTx(tx, actorAccountId, sourceId, authentication);
        return replay.ok ? { ok: true, source: replay.source, canManage: replay.canManage }
            : { ok: false, error: 'source_conflict' };
    }
    if (!(await validateAudienceInTx(tx, actorAccountId, audience, authentication))) return denied();
    const row = await tx.projectSource.create({ data: { createdByAccountId: actorAccountId,
        name: parsed.data.name, repository: json(parsed.data.repository), defaultRef: parsed.data.defaultRef,
        subdir: parsed.data.subdir, audience: json(audience), attachments: [] } });
    const source = sourceFromRow(row);
    if (!source.success) throw new Error('Canonical Source write failed stored admission');
    await saveRepeatKey(tx, requestKey, `${digest}:${row.id}`, defaultRepeatKeyExpiresAt(now));
    await publishInTx(tx, [source.data]);
    return { ok: true, source: source.data, canManage: true };
}

/** Read disclosure is admitted from current Account, Team and Group lifetimes. */
export async function readProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesReadOutputV1> {
    const parsed = ProjectSourcesReadInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const loaded = await loadInTx(tx, actorAccountId, parsed.data.sourceId, authentication);
    return loaded.ok ? { ok: true, source: loaded.source, canManage: loaded.canManage } : loaded.failure;
}

/** Revision CAS protects metadata and exact attachment intents, never document rights or bytes. */
export async function updateProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesReadOutputV1> {
    const parsed = ProjectSourcesUpdateInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const loaded = await loadInTx(tx, actorAccountId, parsed.data.sourceId, authentication);
    if (!loaded.ok) return loaded.failure;
    if (!loaded.canManage) return denied();
    const source = loaded.source;
    if (source.revision !== parsed.data.expectedRevision) return { ok: false, error: 'source_conflict', current: source };
    const patch = parsed.data.patch;
    if (patch.audience && !(await validateAudienceInTx(tx, actorAccountId, patch.audience, authentication))) return denied();
    const next: ProjectSourceV1 = { ...source, ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.repository === undefined ? {} : { repository: patch.repository }),
        ...(patch.audience === undefined ? {} : { audience: patch.audience }) };
    if (patch.defaultRef !== undefined) { delete next.defaultRef; if (patch.defaultRef !== null) next.defaultRef = patch.defaultRef; }
    if (patch.subdir !== undefined) { delete next.subdir; if (patch.subdir !== null) next.subdir = patch.subdir; }
    if (patch.attachment) {
        const applied = await applyAttachmentInTx(tx, actorAccountId, parsed.data.serverId, source, patch.attachment);
        if (!applied.ok) return applied.failure;
        next.attachments = applied.attachments;
    }
    const changed = !isDeepStrictEqual(source, next);
    const result = await tx.projectSource.updateMany({ where: { id: source.id, revision: source.revision }, data: {
        name: next.name, repository: json(next.repository), defaultRef: next.defaultRef ?? null,
        subdir: next.subdir ?? null, audience: json(next.audience), attachments: json(next.attachments ?? []),
        ...(changed ? { revision: { increment: 1 } } : {}),
    } });
    if (result.count !== 1) {
        const current = await loadInTx(tx, actorAccountId, source.id, authentication);
        return current.ok ? { ok: false, error: 'source_conflict', current: current.source } : current.failure;
    }
    if (changed) { next.revision++; await publishInTx(tx, [source, next]); }
    const admission = await admissionInTx(tx, actorAccountId, next.audience, authentication);
    return { ok: true, source: next, canManage: admission.canManage(next.createdByAccountId, next.audience) };
}

/** Removing metadata never invokes daemon, filesystem, setup, or Artifact deletion. */
export async function deleteProjectSourceInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesDeleteOutputV1> {
    const parsed = ProjectSourcesDeleteInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const loaded = await loadInTx(tx, actorAccountId, parsed.data.sourceId, authentication);
    if (!loaded.ok) return loaded.failure;
    if (!loaded.canManage) return denied();
    if (loaded.source.revision !== parsed.data.expectedRevision) return { ok: false, error: 'source_conflict', current: loaded.source };
    const result = await tx.projectSource.deleteMany({ where: { id: loaded.source.id, revision: parsed.data.expectedRevision } });
    if (result.count !== 1) {
        const current = await loadInTx(tx, actorAccountId, loaded.source.id, authentication);
        return current.ok ? { ok: false, error: 'source_conflict', current: current.source } : current.failure;
    }
    await publishInTx(tx, [loaded.source]);
    return { ok: true, sourceId: loaded.source.id, revision: loaded.source.revision };
}

/** Search and coverage are over admitted metadata, not an unfiltered database page. */
export async function listProjectSourcesInTx(tx: Tx, actorAccountId: string, input: unknown, authentication: Authentication = {}): Promise<ProjectSourcesListOutputV1> {
    const parsed = ProjectSourcesListInputV1Schema.safeParse(input);
    if (!parsed.success) return invalid();
    const rows = await tx.projectSource.findMany({ orderBy: { id: 'asc' }, ...(parsed.data.cursor ? { where: { id: { gt: parsed.data.cursor } } } : {}) });
    const admission = await admissionInTx(tx, actorAccountId, rows.flatMap(row => {
        const audience = storedAudience.safeParse(row.audience);
        return audience.success ? audience.data : [];
    }), authentication);
    if (!admission.active) return unavailable();
    const admitted: ProjectSourceV1[] = [];
    for (const row of rows) {
        const audience = storedAudience.safeParse(row.audience);
        if (!admission.canRead(row.createdByAccountId, audience.success ? audience.data : [])) continue;
        const source = sourceFromRow(row);
        if (!source.success) return invalid();
        admitted.push(source.data);
    }
    const query = parsed.data.query?.trim().toLocaleLowerCase();
    const sources = admitted.filter(source => admission.canRead(source.createdByAccountId, source.audience)
        && (!parsed.data.audience || source.audience.some(grant => isDeepStrictEqual(grant.principal, parsed.data.audience)))
        && (!query || [source.name, source.repository.repository.nameWithOwner, source.defaultRef, source.subdir].some(value => value?.toLocaleLowerCase().includes(query))));
    const page = parsed.data.limit === undefined ? sources : sources.slice(0, parsed.data.limit);
    const complete = page.length === sources.length;
    return { ok: true, sources: page, coverage: { complete, nextCursor: complete ? null : page.at(-1)?.id ?? null } };
}
