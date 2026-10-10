import type {
    SessionListQueryResponseV1,
    SessionListQueryV1,
    V2SessionListCursorV2,
    V2SessionListResponse,
} from "@happier-dev/protocol";
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SessionListQueryResponseV1Schema } from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { fetchSessionOrganizationPinnedSessionIds } from "@/app/session/organization/organizationQueries";
import { buildSessionAccessWhere, createApplicableAudienceWhere, resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { isSessionCollaborationEnabled } from "@/app/session/access/sessionAccess";
import { hasSessionTranscriptPublicationLiveFacts } from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    createSessionPersonalAttentionQueryInTx,
    createSessionListScopeWhere,
} from "@/app/session/personal/queries";
import type { SessionPersonalDiscussionFacts } from "@/app/session/personal/discussionFacts";
import {
    readSessionMetadataOwnerAccountModes,
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    createV2SessionListRowPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    readSessionListOtherNamedCollaboratorFacts,
    readSessionListViewerDiscussionFacts,
    resolveV2SessionListCursorForVisibleRows,
    type SessionListReadSource,
    type SessionListRowAdmission,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
} from "./page";
import { createV2SessionAttentionPage, createV2SessionListInitialPage } from "./initialPage";
import {
    conjoinSessionListWhereInputs,
    createFilteredSessionListWhere,
    createLegacyActiveSessionListWhere,
    createSessionListStorageWhere,
    createSessionViewerTagWhere,
} from "./query";
import type { createV2SessionListServerTiming } from "./timing";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { readSessionLedSubtreeSessionIdsInTx } from "@/app/session/relations/sessionReportsToSubtree";
import { projectSessionReportsForRowsInTx } from "@/app/session/awareness/sessionReportsProjection";

export class SessionListInvalidCursorError extends Error {
    constructor() {
        super("Invalid cursor format");
        this.name = "SessionListInvalidCursorError";
    }
}

export class SessionListUnavailableQueryError extends Error {
    constructor(readonly reason: "audience" | "scope" | "following") {
        super(`Session list query ${reason} producer is unavailable`);
        this.name = "SessionListUnavailableQueryError";
    }
}

export async function readSessionListOwnerAccountModes(rows: readonly Readonly<{
    accountId: string;
    metadataLayoutVersion?: number | null;
}>[], reader: Pick<Tx, "account"> = db): Promise<ReadonlyMap<string, SessionMetadataOwnerAccountMode>> {
    return await readSessionMetadataOwnerAccountModes(
        reader,
        rows.filter((session) => requiresSessionMetadataOwnerAccountMode({ session })).map((session) => session.accountId),
    );
}

type LegacySessionListSource = Readonly<{
    kind: "legacy";
    storage: "active" | "archived";
    activeOnly?: boolean;
    cursor?: string;
    attentionCursor?: string;
    limit?: number;
    includeAttention?: boolean;
    includeActive?: boolean;
}>;

type FilteredSessionListSource = Readonly<{
    kind: "query";
    query: SessionListQueryV1;
}>;

type SessionListSource = LegacySessionListSource | FilteredSessionListSource;

/** One service owns legacy and strict-query cursor, row, pin and attention mechanics. */
export async function listSessionsForAccount(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    source: SessionListSource;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<V2SessionListResponse | SessionListQueryResponseV1 | null> {
    const source = params.source;
    if (source.kind === "query") {
        return await listFilteredSessionsForAccount({
            userId: params.userId,
            authentication: params.authentication,
            source,
            rowRepresentabilityWhere: params.rowRepresentabilityWhere,
            timing: params.timing,
        });
    }
    return await inTx(async (tx) => {
        const now = Date.now();
        const accessResolution = {
            where: buildSessionAccessWhere({
                accountId: params.userId,
                capability: "readTranscript",
                mode: "legacy_owner_or_direct",
            }),
            qualifiedTeamIds: new Set<string>(),
        };
        const readSource: SessionListReadSource = {
            kind: "effective",
            reader: tx,
            baseWhere: accessResolution.where,
            accessMode: "legacy_owner_or_direct",
            allowProjectionFallback: true,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            discussionReader: tx,
        };
        const where = conjoinSessionListWhereInputs(
            source.activeOnly
                ? createLegacyActiveSessionListWhere(now)
                : createSessionListStorageWhere(source.storage),
            params.rowRepresentabilityWhere,
        );
        const needsAttentionWhere = source.storage === "active"
            && (source.includeAttention === true || source.attentionCursor !== undefined);
        const attentionQuery = needsAttentionWhere
            ? createSessionPersonalAttentionQueryInTx(tx, {
                accountId: params.userId,
                qualifiedTeamIds: accessResolution.qualifiedTeamIds,
                now,
                captureObservedDiscussionFacts: true,
            })
            : undefined;
        const page = await listSessionRowsForAccount({
            ...params,
            storage: source.storage,
            activeOnly: source.activeOnly,
            cursor: source.cursor,
            attentionCursor: source.attentionCursor,
            limit: source.limit,
            includeAttention: source.includeAttention,
            includeActive: source.includeActive,
            where,
            readSource,
            attentionWhere: attentionQuery?.candidateWhere,
            attentionRowAdmission: attentionQuery?.admitRows,
            observedAttentionDiscussionFacts: attentionQuery?.observedDiscussionFacts,
            now,
        });
        return page && {
            ...page,
            sessions: await projectSessionReportsForRowsInTx(tx, {
                accountId: params.userId,
                authentication: params.authentication,
                sessions: page.sessions,
                accessMode: "legacy_owner_or_direct",
                nowMs: now,
            }),
        };
    }, { readOnly: true });
}

async function listSessionRowsForAccount(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    storage: "active" | "archived";
    activeOnly?: boolean;
    cursor?: string;
    attentionCursor?: string;
    limit?: number;
    includeAttention?: boolean;
    includeActive?: boolean;
    where: Prisma.SessionWhereInput;
    readSource?: SessionListReadSource;
    attentionWhere?: Prisma.SessionWhereInput;
    rowAdmission?: SessionListRowAdmission;
    attentionRowAdmission?: SessionListRowAdmission;
    observedAttentionDiscussionFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>;
    now?: number;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<V2SessionListResponse | null> {
    const { userId, timing, where } = params;
    const limit = params.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT;
    const metadataReader = params.readSource?.reader ?? db;
    const readAdmission = params.readSource
        ? { source: params.readSource }
        : { authentication: params.authentication };

    if (params.activeOnly) {
        const rows = await timing.measureAsync("query", () => findV2SessionListRows({
            userId, where, ...readAdmission, orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY, take: limit,
        }));
        const ownerAccountModes = await readSessionListOwnerAccountModes(rows, metadataReader);
        const discussionFacts = await readSessionListViewerDiscussionFacts(
            rows,
            userId,
            params.readSource?.discussionReader,
            params.observedAttentionDiscussionFacts,
        );
        const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(rows, userId, params.readSource?.discussionReader);
        return timing.measure("page", () => ({ ...mapV2SessionListRows({
            rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts,
            qualifiedTeamIds: params.readSource?.qualifiedTeamIds,
            accessMode: params.readSource?.accessMode,
            now: params.now,
        }) }));
    }

    if (params.attentionCursor) {
        const cursor = await timing.measureAsync("cursor", () => resolveV2SessionListCursorForVisibleRows({
            userId,
            cursor: params.attentionCursor,
            // An attention continuation identifies the last candidate examined,
            // which may itself have been rejected by the personal projector.
            // Validate it against the candidate corpus, never the admitted rows.
            cursorRowWhere: conjoinSessionListWhereInputs(where, params.attentionWhere),
            ...(params.readSource
                ? { source: params.readSource }
                : { authentication: params.authentication }),
        }));
        if (!cursor) throw new SessionListInvalidCursorError();
        const page = await createV2SessionAttentionPage({
            userId,
            authentication: params.authentication,
            where,
            cursor,
            candidateLimit: limit,
            source: params.readSource,
            attentionWhere: params.attentionWhere,
            rowAdmission: params.attentionRowAdmission,
            now: params.now,
            timing: timing.initialPageTiming(),
        });
        const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, metadataReader);
        const discussionFacts = await readSessionListViewerDiscussionFacts(
            page.rows,
            userId,
            params.readSource?.discussionReader,
            params.observedAttentionDiscussionFacts,
        );
        const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(page.rows, userId, params.readSource?.discussionReader);
        return {
            ...mapV2SessionListRows({
                rows: page.rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts,
                qualifiedTeamIds: params.readSource?.qualifiedTeamIds,
                accessMode: params.readSource?.accessMode,
                now: params.now,
            }),
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: page.attentionNextCursor,
            attentionHasNext: page.attentionHasNext,
        };
    }

    const pinnedSessionIds = params.storage === "active" && !params.cursor
        ? await timing.measureAsync("cursor", () => fetchSessionOrganizationPinnedSessionIds(
            userId,
            params.authentication,
            params.readSource ? {
                reader: params.readSource.reader,
                sessionWhere: conjoinSessionListWhereInputs(params.readSource.baseWhere, where),
            } : undefined,
        ))
        : [];
    let cursor: V2SessionListCursorV2 | undefined;
    if (params.cursor) {
        const decoded = await timing.measureAsync("cursor", () => resolveV2SessionListCursorForVisibleRows({
            userId, cursor: params.cursor, cursorRowWhere: where, ...readAdmission,
            rowAdmission: params.rowAdmission,
        }));
        if (!decoded) throw new SessionListInvalidCursorError();
        cursor = decoded;
    }
    const rows = await timing.measureAsync("query", () => findV2SessionListRows({
        userId, where, cursor, ...readAdmission, orderBy: V2_SESSION_LIST_ORDER_BY, take: limit + 1,
        rowAdmission: params.rowAdmission,
    }));
    const includeAttention = params.storage === "active" && !params.cursor && params.includeAttention === true;
    const includeActive = params.storage === "active" && !params.cursor && params.includeActive === true;
    if (!params.cursor && (pinnedSessionIds.length > 0 || includeAttention || includeActive)) {
        return await createV2SessionListInitialPage({
            userId,
            authentication: params.authentication,
            where,
            readOwnerAccountModes: (accountIds) => readSessionMetadataOwnerAccountModes(metadataReader, accountIds),
            readViewerDiscussionFacts: (pageRows) => readSessionListViewerDiscussionFacts(
                pageRows,
                userId,
                params.readSource?.discussionReader,
                params.observedAttentionDiscussionFacts,
            ),
            readOtherNamedCollaboratorFacts: (pageRows) => readSessionListOtherNamedCollaboratorFacts(pageRows, userId, params.readSource?.discussionReader),
            pageRows: rows,
            limit,
            pinnedSessionIds,
            includeAttentionRows: includeAttention,
            includeActiveRows: includeActive,
            activeRowsLimit: V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
            source: params.readSource,
            attentionWhere: params.attentionWhere,
            rowAdmission: params.rowAdmission,
            attentionRowAdmission: params.attentionRowAdmission,
            now: params.now,
            timing: timing.initialPageTiming(),
        });
    }
    const page = createV2SessionListRowPage({ rows, limit });
    const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, metadataReader);
    const discussionFacts = await readSessionListViewerDiscussionFacts(
        page.rows,
        userId,
        params.readSource?.discussionReader,
        params.observedAttentionDiscussionFacts,
    );
    const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(page.rows, userId, params.readSource?.discussionReader);
    return timing.measure("page", () => ({
        ...mapV2SessionListRows({
            rows: page.rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts,
            qualifiedTeamIds: params.readSource?.qualifiedTeamIds,
            accessMode: params.readSource?.accessMode,
            now: params.now,
        }),
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
    }));
}

async function listFilteredSessionsForAccount(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    source: FilteredSessionListSource;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<SessionListQueryResponseV1 | null> {
    const { query } = params.source;
    // Decided before the listing transaction opens, on the Home-effective configuration.
    if (query.scope === "following" && !await isServerFeatureEnabledForHome("sessions.following")) {
        throw new SessionListUnavailableQueryError("following");
    }
    if (query.audiences.some((audience) => audience.kind !== "outside_teams")
        && !isSessionCollaborationEnabled()) {
        throw new SessionListUnavailableQueryError("audience");
    }

    return await inTx(async (tx) => {
        const accessResolution = await resolveEffectiveSessionAccessWhere({
            tx,
            accountId: params.userId,
            capability: "readTranscript",
            mode: "effective_access_v1",
            authentication: params.authentication,
        });
        const accessWhere = accessResolution.where;
        const audienceWhere = await createApplicableAudienceWhere({
            tx,
            accountId: params.userId,
            audiences: query.audiences,
            authentication: params.authentication,
            collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
        });
        const now = Date.now();
        let scopeWhere;
        try {
            scopeWhere = createSessionListScopeWhere({ accountId: params.userId, scope: query.scope });
        } catch {
            throw new SessionListUnavailableQueryError("scope");
        }
        const needsAttentionWhere = query.attention === "needs_my_attention"
            || !query.includeInactive
            || query.includeAttention === true
            || query.attentionCursor !== undefined;
        const attentionQuery = createSessionPersonalAttentionQueryInTx(tx, {
            accountId: params.userId,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            now,
            captureObservedDiscussionFacts: true,
        });
        const attentionWhere = needsAttentionWhere
            ? attentionQuery.candidateWhere
            : { id: { in: [] } };
        const admitAttentionRows: SessionListRowAdmission = attentionQuery.admitRows;
        const rowAdmission: SessionListRowAdmission | undefined = query.attention === "needs_my_attention"
            ? admitAttentionRows
            : !query.includeInactive
                ? async (rows) => {
                    // Publication decides liveness, not the raw stored column:
                    // a row that projects `active: false` must earn its place
                    // through attention like any other inactive row.
                    const isPublishedActive = (row: typeof rows[number]) => (
                        row.active && hasSessionTranscriptPublicationLiveFacts(row)
                    );
                    const inactiveRows = rows.filter((row) => !isPublishedActive(row));
                    if (inactiveRows.length === 0) return rows;
                    const admittedInactiveIds = new Set(
                        (await admitAttentionRows(inactiveRows)).map((row) => row.id),
                    );
                    return rows.filter((row) => isPublishedActive(row) || admittedInactiveIds.has(row.id));
                }
                : undefined;
        const baseWhere = createFilteredSessionListWhere({
            accountId: params.userId,
            query,
            accessWhere,
            scopeWhere,
            audienceWhere,
            attentionWhere,
        });
        const subtreeWhere: Prisma.SessionWhereInput = query.underSessionId
            ? { id: { in: await readSessionLedSubtreeSessionIdsInTx(tx, {
                accountId: params.userId,
                rootSessionId: query.underSessionId,
                authentication: params.authentication,
                collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
            }) } }
            : {};
        const readSource: SessionListReadSource = {
            kind: "effective",
            reader: tx,
            baseWhere: conjoinSessionListWhereInputs(baseWhere, subtreeWhere, params.rowRepresentabilityWhere),
            accessMode: "effective_access_v1",
            allowProjectionFallback: false,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            discussionReader: tx,
        };
        const page = await listSessionRowsForAccount({
            userId: params.userId,
            authentication: params.authentication,
            storage: query.storage,
            cursor: query.cursor,
            attentionCursor: query.attentionCursor,
            limit: query.limit,
            includeAttention: query.includeAttention,
            where: {},
            readSource,
            attentionWhere,
            rowAdmission,
            attentionRowAdmission: admitAttentionRows,
            observedAttentionDiscussionFacts: attentionQuery.observedDiscussionFacts,
            now,
            rowRepresentabilityWhere: params.rowRepresentabilityWhere,
            timing: params.timing,
        });
        return page && SessionListQueryResponseV1Schema.parse({
            sessions: await projectSessionReportsForRowsInTx(tx, {
                accountId: params.userId,
                authentication: params.authentication,
                sessions: page.sessions,
                accessMode: "effective_access_v1",
                collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                nowMs: now,
            }),
            nextCursor: page.nextCursor ?? null,
            hasNext: page.hasNext ?? false,
            attentionNextCursor: page.attentionNextCursor ?? null,
            attentionHasNext: page.attentionHasNext ?? false,
            ...(page.metadataUpgradeRequiredCount !== undefined
                ? { metadataUpgradeRequiredCount: page.metadataUpgradeRequiredCount }
                : {}),
        });
    }, { readOnly: true });
}
