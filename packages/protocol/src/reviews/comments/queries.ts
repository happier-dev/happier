import type { ReviewCommentListRequestV1 } from './actions.js';
import type { ReviewCommentActorRefV1 } from './v1.js';
import type { ReviewCommentV1 } from './v1.js';

export type ReviewCommentQueryRecordV1 = Pick<ReviewCommentV1, 'reviewId' | 'roundOrdinal' | 'appearances' | 'workspace' | 'workspaceId' | 'projectId' | 'sessionId' | 'runId' | 'engineId' | 'state' | 'flags' | 'tombstone' | 'author' | 'metadata' | 'id' | 'updatedAt' | 'serverRevision'> & Readonly<{ anchor: Readonly<{ kind?: ReviewCommentV1['anchor']['kind']; filePath?: string; folderPath?: string }> }>;

export type ReviewCommentCanonicalFilters = Readonly<{
    reviewId?: string;
    commentIds?: readonly string[];
    roundOrdinal?: number;
    projectId?: string;
    workspace?: ReviewCommentV1["workspace"];
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    engineId?: string;
    states: readonly string[];
    authorKind?: string;
    authorId?: string;
    filePath?: string;
    folderPath?: string;
    severity?: string;
    taxonomyIds: readonly string[];
    includeHistory: boolean;
}>;

export function canonicalReviewCommentListFilters(
    filters: ReviewCommentListRequestV1,
): ReviewCommentCanonicalFilters {
    const normalized = normalizeReviewCommentListFilters(filters);
    return {
        reviewId: normalized.reviewId,
        commentIds: normalized.commentIds === undefined ? undefined : [...new Set(normalized.commentIds)].sort(),
        roundOrdinal: normalized.roundOrdinal,
        projectId: normalized.projectId,
        workspace: normalized.workspace ? { machineId: normalized.workspace.machineId, path: normalized.workspace.path } : undefined,
        workspaceId: normalized.workspaceId,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
        engineId: normalized.engineId,
        states: [...normalized.states].sort(),
        authorKind: normalized.authorKind,
        authorId: normalized.authorId,
        filePath: normalized.filePath,
        folderPath: normalized.folderPath,
        severity: normalized.severity,
        taxonomyIds: [...(normalized.taxonomyIds ?? [])].sort(),
        includeHistory: normalized.includeHistory,
    };
}

function actorIdentity(actor: ReviewCommentActorRefV1): string {
    if (actor.kind === "plugin") return actor.pluginId;
    if (actor.kind === "agent") return actor.agentId;
    if (actor.kind === "workflow") return actor.runId;
    return actor.userId;
}

function isHistoryComment(comment: ReviewCommentQueryRecordV1): boolean {
    return comment.state === "resolved"
        || comment.state === "dismissed"
        || comment.flags.redacted === true
        || Boolean(comment.tombstone);
}

export function normalizeReviewCommentListFilters(
    filters: ReviewCommentListRequestV1,
): ReviewCommentListRequestV1 {
    return {
        ...filters,
        states: [...(filters.states ?? [])],
        includeHistory: filters.includeHistory ?? false,
        limit: filters.limit ?? 50,
    };
}

export function compareReviewCommentListOrder(left: Pick<ReviewCommentV1, 'id' | 'updatedAt' | 'serverRevision'>, right: Pick<ReviewCommentV1, 'id' | 'updatedAt' | 'serverRevision'>): number {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.serverRevision !== right.serverRevision) return right.serverRevision - left.serverRevision;
    return right.id.localeCompare(left.id);
}

function matchesFolderFilter(comment: ReviewCommentQueryRecordV1, folderPath: string): boolean {
    const anchor = comment.anchor;
    if ("folderPath" in anchor) return anchor.folderPath === folderPath;
    if (typeof anchor.filePath === 'string') return anchor.filePath === folderPath || anchor.filePath.startsWith(`${folderPath}/`);
    return false;
}

export function matchesReviewCommentListFilters(
    comment: ReviewCommentQueryRecordV1,
    filters: ReviewCommentListRequestV1,
): boolean {
    const normalized = normalizeReviewCommentListFilters(filters);
    if (normalized.commentIds !== undefined && !normalized.commentIds.includes(comment.id)) return false;
    if (normalized.reviewId && comment.reviewId !== normalized.reviewId) return false;
    const appearanceScope = comment.reviewId && (normalized.roundOrdinal || normalized.runId || normalized.sessionId || normalized.engineId);
    if (normalized.roundOrdinal && !comment.reviewId) return false;
    if (normalized.workspaceId && comment.workspaceId !== normalized.workspaceId) return false;
    if (!appearanceScope && normalized.projectId && comment.projectId !== normalized.projectId) return false;
    if (!appearanceScope && normalized.workspace && (comment.workspace?.machineId !== normalized.workspace.machineId
        || comment.workspace?.path !== normalized.workspace.path)) return false;
    if (appearanceScope) {
        const directlyAttached = comment.roundOrdinal !== undefined
            && (!normalized.roundOrdinal || comment.roundOrdinal === normalized.roundOrdinal)
            && (!normalized.runId || comment.runId === normalized.runId)
            && (!normalized.sessionId || comment.sessionId === normalized.sessionId)
            && (!normalized.engineId || comment.engineId === normalized.engineId)
            && (!normalized.workspace || (comment.workspace?.machineId === normalized.workspace.machineId
                && comment.workspace.path === normalized.workspace.path));
        if (!directlyAttached && !comment.appearances?.some(appearance => (!normalized.runId || appearance.runId === normalized.runId)
            && (!normalized.roundOrdinal || appearance.roundOrdinal === normalized.roundOrdinal)
            && (!normalized.sessionId || appearance.sessionId === normalized.sessionId)
            && (!normalized.engineId || appearance.reviewerId === normalized.engineId)
            && (!normalized.workspace || appearance.machineId === normalized.workspace.machineId))) return false;
    } else {
        if (normalized.sessionId && comment.sessionId !== normalized.sessionId) return false;
        if (normalized.runId && comment.runId !== normalized.runId) return false;
        if (normalized.engineId && comment.engineId !== normalized.engineId) return false;
    }
    if (normalized.states.length > 0 && !normalized.states.includes(comment.state)) return false;
    if (!normalized.includeHistory && isHistoryComment(comment)) return false;
    if (normalized.authorKind && comment.author.kind !== normalized.authorKind) return false;
    if (normalized.authorId && actorIdentity(comment.author) !== normalized.authorId) return false;
    if (normalized.filePath) {
        const anchor = comment.anchor;
        if (!("filePath" in anchor) || anchor.filePath !== normalized.filePath) return false;
    }
    if (normalized.folderPath && !matchesFolderFilter(comment, normalized.folderPath)) return false;
    if (normalized.severity && comment.metadata?.severity !== normalized.severity) return false;
    if (
        normalized.taxonomyIds
        && normalized.taxonomyIds.length > 0
        && !normalized.taxonomyIds.some((taxonomyId) => comment.metadata?.taxonomyIds?.includes(taxonomyId) === true)
    ) {
        return false;
    }
    return true;
}
