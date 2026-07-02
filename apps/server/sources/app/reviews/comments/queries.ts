import type {
    ReviewCommentActorRefV1,
    ReviewCommentListRequestV1,
    ReviewCommentV1,
} from "@happier-dev/protocol";

import { ReviewCommentOperationError } from "./errors";

type ReviewCommentListPosition = Readonly<{
    updatedAt: number;
    serverRevision: number;
    id: string;
}>;

type ReviewCommentCursorPayload = Readonly<{
    v: 1;
    filters: ReviewCommentCanonicalFilters;
    position: ReviewCommentListPosition;
}>;

type ReviewCommentCanonicalFilters = Readonly<{
    projectId?: string;
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

export type ReviewCommentListResult = Readonly<{
    items: readonly ReviewCommentV1[];
    cursor: string | null;
}>;

function actorIdentity(actor: ReviewCommentActorRefV1): string {
    if (actor.kind === "plugin") return actor.pluginId;
    if (actor.kind === "agent") return actor.agentId;
    return actor.userId;
}

function isHistoryComment(comment: ReviewCommentV1): boolean {
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

export function canonicalReviewCommentListFilters(
    filters: ReviewCommentListRequestV1,
): ReviewCommentCanonicalFilters {
    const normalized = normalizeReviewCommentListFilters(filters);
    return {
        projectId: normalized.projectId,
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

function encodeCursorPayload(payload: ReviewCommentCursorPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorPayload(cursor: string): ReviewCommentCursorPayload {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
            !parsed
            || typeof parsed !== "object"
            || parsed.v !== 1
            || !parsed.position
            || typeof parsed.position !== "object"
            || typeof parsed.position.updatedAt !== "number"
            || typeof parsed.position.serverRevision !== "number"
            || typeof parsed.position.id !== "string"
        ) {
            throw new Error("invalid cursor");
        }
        return parsed as ReviewCommentCursorPayload;
    } catch {
        throw new ReviewCommentOperationError(
            "review_comment_invalid_filter",
            "Review comment cursor is invalid",
        );
    }
}

function assertCursorFiltersMatch(params: Readonly<{
    cursor: ReviewCommentCursorPayload;
    filters: ReviewCommentListRequestV1;
}>): void {
    const expected = JSON.stringify(params.cursor.filters);
    const actual = JSON.stringify(canonicalReviewCommentListFilters(params.filters));
    if (expected !== actual) {
        throw new ReviewCommentOperationError(
            "review_comment_invalid_filter",
            "Review comment cursor does not match the active filters",
        );
    }
}

function commentPosition(comment: ReviewCommentV1): ReviewCommentListPosition {
    return {
        updatedAt: comment.updatedAt,
        serverRevision: comment.serverRevision,
        id: comment.id,
    };
}

export function compareReviewCommentListOrder(left: ReviewCommentV1, right: ReviewCommentV1): number {
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.serverRevision !== right.serverRevision) return right.serverRevision - left.serverRevision;
    return right.id.localeCompare(left.id);
}

function comparePositionToComment(left: ReviewCommentV1, right: ReviewCommentListPosition): number {
    return compareReviewCommentListOrder(left, {
        ...left,
        id: right.id,
        updatedAt: right.updatedAt,
        serverRevision: right.serverRevision,
    });
}

function matchesFolderFilter(comment: ReviewCommentV1, folderPath: string): boolean {
    const anchor = comment.anchor;
    if ("folderPath" in anchor) return anchor.folderPath === folderPath;
    if ("filePath" in anchor) return anchor.filePath === folderPath || anchor.filePath.startsWith(`${folderPath}/`);
    return false;
}

export function matchesReviewCommentListFilters(
    comment: ReviewCommentV1,
    filters: ReviewCommentListRequestV1,
): boolean {
    const normalized = normalizeReviewCommentListFilters(filters);
    if (normalized.workspaceId && comment.workspaceId !== normalized.workspaceId) return false;
    if (normalized.projectId && comment.projectId !== normalized.projectId) return false;
    if (normalized.sessionId && comment.sessionId !== normalized.sessionId) return false;
    if (normalized.runId && comment.runId !== normalized.runId) return false;
    if (normalized.engineId && comment.engineId !== normalized.engineId) return false;
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

export function applyReviewCommentListQuery(
    comments: readonly ReviewCommentV1[],
    filters: ReviewCommentListRequestV1,
): ReviewCommentListResult {
    const normalized = normalizeReviewCommentListFilters(filters);
    const cursor = normalized.cursor ? decodeCursorPayload(normalized.cursor) : null;
    if (cursor) assertCursorFiltersMatch({ cursor, filters: normalized });

    const filtered = comments
        .filter((comment) => matchesReviewCommentListFilters(comment, normalized))
        .sort(compareReviewCommentListOrder)
        .filter((comment) => !cursor || comparePositionToComment(comment, cursor.position) > 0);
    const page = filtered.slice(0, normalized.limit);
    const hasMore = filtered.length > normalized.limit;
    const last = page.at(-1);

    return {
        items: page,
        cursor: hasMore && last
            ? encodeCursorPayload({
                v: 1,
                filters: canonicalReviewCommentListFilters(normalized),
                position: commentPosition(last),
            })
            : null,
    };
}
