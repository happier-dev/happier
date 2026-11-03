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
    tagIds: readonly string[];
}>): Prisma.SessionWhereInput {
    return params.tagIds.length === 0
        ? {}
        : {
            sessionTagAssignments: {
                some: {
                    accountId: params.accountId,
                    tagId: { in: [...params.tagIds] },
                },
            },
        };
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
        // Null keys precede accepted identity publication. Keep them for the
        // client's canonical Workspace resolver, not a second SQL identity rule.
        query.projectKeys && (query.projectKeys.include.length || query.projectKeys.exclude.length)
            ? { OR: [{ projectKey: null }, { projectKey: {
                ...(query.projectKeys.include.length ? { in: [...query.projectKeys.include] } : {}),
                ...(query.projectKeys.exclude.length ? { notIn: [...query.projectKeys.exclude] } : {}),
            } }] }
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
