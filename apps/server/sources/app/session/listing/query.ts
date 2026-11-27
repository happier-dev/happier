import type { Prisma } from "@prisma/client";
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { createSessionTranscriptPublicationLiveFactsWhere } from "@/app/session/sessionTranscriptPublicationPolicy";

const ACTIVE_SESSION_WINDOW_MS = 1000 * 60 * 15;

function normalizeWhereClauses(
    value: Prisma.SessionWhereInput["AND"],
): Prisma.SessionWhereInput[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * Keep every independently owned list predicate as one explicit conjunction.
 * Splitting top-level fields from an input's existing `AND` prevents object
 * spreading from replacing another owner's `OR`/`AND` while keeping the final
 * query shape inspectable by the pagination and provider test harnesses.
 */
export function conjoinSessionListWhereInputs(
    ...inputs: readonly (Prisma.SessionWhereInput | undefined)[]
): Prisma.SessionWhereInput {
    const clauses: Prisma.SessionWhereInput[] = [];
    for (const input of inputs) {
        if (!input) continue;
        const { AND, ...rest } = input;
        if (Object.keys(rest).length > 0) clauses.push(rest);
        clauses.push(...normalizeWhereClauses(AND));
    }
    return { AND: clauses };
}

/** Execute the scope owner's union through independently indexable keysets. */
export function createSessionListScopeQueryBranches(scope: Prisma.SessionWhereInput): Prisma.SessionWhereInput[] {
    const { OR, ...rest } = scope;
    if (!OR) return [scope];
    const owned = OR.find(arm => Object.keys(arm).length === 1 && typeof arm.accountId === 'string');
    if (!owned || typeof owned.accountId !== 'string') return [scope];
    // Factor the compiled ownership equality, not the personal scope policy.
    // The other arm keeps P03's BitmapOr over responsibility and exact ids.
    // Excluding owned rows makes these two sources disjoint before their limit.
    return [conjoinSessionListWhereInputs(rest, owned), conjoinSessionListWhereInputs(rest, {
        accountId: { not: owned.accountId }, OR: OR.filter(arm => arm !== owned),
    })];
}

/** Legacy GET visibility stays owner/direct; broad audience and personal scopes are separate contracts. */
export function createLegacySessionListWhere(params: Readonly<{
    userId: string;
    where?: Prisma.SessionWhereInput;
}>): Prisma.SessionWhereInput {
    return conjoinSessionListWhereInputs(
        buildSessionAccessWhere({ accountId: params.userId, capability: "readTranscript", mode: "legacy_owner_or_direct" }),
        params.where,
    );
}

export function createSessionListStorageWhere(storage: "active" | "archived"): Prisma.SessionWhereInput {
    return { archivedAt: storage === "archived" ? { not: null } : null };
}

export function createLegacyActiveSessionListWhere(now: number): Prisma.SessionWhereInput {
    return {
        AND: [
            createSessionListStorageWhere("active"),
            createSessionTranscriptPublicationLiveFactsWhere(),
            { active: true, lastActiveAt: { gt: new Date(now - ACTIVE_SESSION_WINDOW_MS) } },
        ],
    };
}

export function createSessionViewerTagWhere(params: Readonly<{
    accountId: string;
    tagIds: SessionListQueryV1['tagIds'];
}>): Prisma.SessionWhereInput {
    return conjoinSessionListWhereInputs(
        params.tagIds.include.length ? {
            sessionTagAssignments: { some: {
                accountId: params.accountId, tagId: { in: [...params.tagIds.include] },
            } },
        } : undefined,
        params.tagIds.exclude.length ? {
            sessionTagAssignments: { none: {
                accountId: params.accountId, tagId: { in: [...params.tagIds.exclude] },
            } },
        } : undefined,
    );
}

/**
 * A Project selection admits published members plus Sessions whose owner has not
 * classified them yet: those stay candidates for the client's canonical Workspace
 * resolver (project identity is Home-local/E2EE, so SQL never guesses it). A Session
 * the owner published as in no Project is never a member of an included Project,
 * and never a member of an excluded one.
 */
function createSessionProjectSelectionWhere(projectKeys: Readonly<{
    include: readonly string[];
    exclude: readonly string[];
    none?: true;
}>): Prisma.SessionWhereInput {
    // The owner's reclassification candidates: Sessions it published as in no Project.
    if (projectKeys.none) return { projectKey: null, projectKeyNone: true };
    const keyed = { projectKey: {
        ...(projectKeys.include.length ? { in: [...projectKeys.include] } : {}),
        ...(projectKeys.exclude.length ? { notIn: [...projectKeys.exclude] } : {}),
    } };
    return projectKeys.include.length
        ? { OR: [{ projectKey: null, projectKeyNone: false }, keyed] }
        : { OR: [{ projectKey: null }, keyed] };
}

/**
 * Compose the V1 query only from predicates supplied by their canonical
 * owners. Access, personal scope/attention and applicable-audience semantics
 * are compiled before this boundary; listing owns storage, folders, tags and the
 * inactive-corpus rule.
 */
export function createFilteredSessionListWhere(params: Readonly<{
    accountId: string;
    query: SessionListQueryV1;
    accessWhere: Prisma.SessionWhereInput;
    scopeWhere: Prisma.SessionWhereInput;
    audienceWhere: Prisma.SessionWhereInput;
    attentionWhere: Prisma.SessionWhereInput;
}>): Prisma.SessionWhereInput {
    const { query } = params;
    return conjoinSessionListWhereInputs(
        params.accessWhere,
        createSessionListStorageWhere(query.storage),
        params.scopeWhere,
        params.audienceWhere,
        createSessionViewerTagWhere({ accountId: params.accountId, tagIds: query.tagIds }),
        query.projectKeys && (query.projectKeys.include.length || query.projectKeys.exclude.length || query.projectKeys.none)
            ? createSessionProjectSelectionWhere(query.projectKeys)
            : undefined,
        query.folderIds?.length
            ? {
                sessionFolderAssignments: {
                    some: {
                        accountId: params.accountId,
                        folderId: { in: [...query.folderIds] },
                    },
                },
            }
            : undefined,
        query.attention === "needs_my_attention" ? params.attentionWhere : undefined,
        // "Hide inactive" must select the same liveness the row projection
        // publishes: a Session whose transcript is not hosted publishes
        // `active: false`, so it is only admitted through attention.
        query.includeInactive
            ? undefined
            : {
                OR: [
                    conjoinSessionListWhereInputs(
                        createSessionTranscriptPublicationLiveFactsWhere(),
                        { active: true },
                    ),
                    params.attentionWhere,
                ],
            },
    );
}
