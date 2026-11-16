import type { SessionListQueryResponseV1 } from '@happier-dev/protocol/sessions/listing/response';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import type { V2SessionListCursorV2, V2SessionListResponse } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { SessionListQueryResponseV1Schema, SessionRuntimeManagedSubtreeListResponseV1Schema,
    type SessionRuntimeManagedSubtreeListResponseV1 } from '@happier-dev/protocol/sessions/listing/response';
import type { Prisma } from "@prisma/client";
import { db, getDbProviderFromEnv } from "@/storage/db";
import { resolveV2SessionListCandidateWindowLimit } from './readLimits';
import type { Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { readSessionObservationCursorInTx } from '@/app/session/access/readObservation';
import { fetchSessionOrganizationPinnedSessionIds, fetchSessionTagAssignmentsForAdmittedSessionsInTx } from "@/app/session/organization/organizationQueries";
import { createApplicableAudienceWhere, resolveEffectiveSessionAccessWhere, resolveLegacySessionPageAccessQueryInTx } from "@/app/session/access/sessionAccessWhere";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { isSessionCollaborationEnabled } from "@/app/session/access/sessionAccess";
import { hasSessionTranscriptPublicationLiveFacts } from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    createSessionPersonalAttentionQueryInTx,
    createSessionListScopeWhere,
} from "@/app/session/personal/queries";
import type { SessionPersonalDiscussionFacts } from "@/app/session/personal/discussionFacts";
import { loadSessionLatestFailureSequencesInTx } from "@/app/session/personal/projection";
import { loadSessionRuleReadStatesInTx } from "@/app/session/personal/readState";
import {
    readSessionMetadataOwnerAccountModes,
    isSessionMetadataPrivacyUpgradeRequiredError,
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    createV2SessionListRowPage,
    findV2SessionListRows,
    findV2SessionListCandidatePage,
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
    createSessionListScopeQueryBranches,
    createLegacyActiveSessionListWhere,
    createSessionListStorageWhere,
    createSessionViewerTagWhere,
} from "./query";
import type { createV2SessionListServerTiming } from "./timing";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { readSessionManagedSubtreeSessionIdsInTx, projectSessionRuntimeManagedSubtreeAccess } from "@/app/session/follow/sessionManagerSubtree";
import { projectSessionManagerForRowsInTx } from "@/app/session/awareness/sessionManagerProjection";
import { readAccountFollowRuleProjectionRowsInTx, projectAccountFollowRuleReceiverCounts } from '@/app/session/follow/accountFollowRuleService';
import { deriveSessionCoordinatorV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { mapV2SessionCompactListRow } from './rows';

/** PostgreSQL JIT-compiles the page's access predicate per statement, costing about 10× the scan itself. */
function captureSessionListingSnapshot<T>(read: (tx: Tx) => Promise<T>): Promise<T> {
    return captureReadSnapshot(async tx => {
        if (getDbProviderFromEnv(process.env, "postgres") === "postgres") await tx.$executeRawUnsafe("SET LOCAL jit = off");
        return await read(tx);
    }, { transactionClass: "session-listing-read" });
}

export class SessionListCredentialScopeDeniedError extends Error {
    readonly code = 'credential_scope_denied';
    constructor() { super('credential_scope_denied'); }
}

export class SessionListInvalidCursorError extends Error {
    constructor() {
        super("Invalid cursor format");
        this.name = "SessionListInvalidCursorError";
    }
}

export class SessionListUnavailableQueryError extends Error {
    constructor(readonly reason: "audience" | "scope" | "following" | "coordinator") {
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
}>): Promise<V2SessionListResponse | SessionListQueryResponseV1 | SessionRuntimeManagedSubtreeListResponseV1 | null> {
    const source = params.source;
    if (params.authentication.sessionRuntimePrincipal) {
        if (source.kind !== 'query') throw new SessionListCredentialScopeDeniedError();
        return await listSessionRuntimeManagedSubtree({ ...params, source });
    }
    if (source.kind === "query") {
        return await listFilteredSessionsForAccount({
            userId: params.userId,
            authentication: params.authentication,
            source,
            rowRepresentabilityWhere: params.rowRepresentabilityWhere,
            timing: params.timing,
        });
    }
    return await captureSessionListingSnapshot(async (tx) => await params.timing.measureAsync("snapshot", async () => {
        const observationCursor = await readSessionObservationCursorInTx(tx, params.userId, params.authentication);
        const now = Date.now();
        const accessResolution = {
            ...await resolveLegacySessionPageAccessQueryInTx(tx, {
                accountId: params.userId,
                capability: "readTranscript",
            }),
            qualifiedTeamIds: new Set<string>(),
        };
        const ruleRows = await readAccountFollowRuleProjectionRowsInTx(tx, { accountId: params.userId, authentication: params.authentication });
        const ruleReceiverCounts = projectAccountFollowRuleReceiverCounts(ruleRows);
        const readSource: SessionListReadSource = {
            kind: "effective",
            reader: tx,
            baseWhere: accessResolution.where,
            baseWhereBranches: accessResolution.queryBranches,
            accessMode: "legacy_owner_or_direct",
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            discussionReader: tx,
            ruleRows,
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
            observedAttentionFailureSequences: attentionQuery?.observedFailureSequences,
            now,
        });
        return page && {
            ...page,
            observationCursor,
            sessions: await projectSessionManagerForRowsInTx(tx, {
                accountId: params.userId,
                authentication: params.authentication,
                sessions: page.sessions,
                accessMode: "legacy_owner_or_direct",
                nowMs: now,
                ruleReceiverCounts,
            }),
        };
    }));
}

/** Restricted listing uses the canonical subtree, paging and shared row projection. */
async function listSessionRuntimeManagedSubtree(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    source: FilteredSessionListSource;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<SessionRuntimeManagedSubtreeListResponseV1> {
    const { query } = params.source;
    const principal = params.authentication.sessionRuntimePrincipal;
    if (!principal || principal.accountId !== params.userId || query.underSessionId !== principal.sessionId
        || query.scope !== 'all_accessible' || query.attention !== 'any'
        || query.audiences.length || query.tagIds.length || query.folderIds?.length
        || query.projectKeys?.include.length || query.projectKeys?.exclude.length || query.projectKeys?.none
        || query.coordinator !== undefined || query.membership !== undefined
        || query.includeAttention === true || query.attentionCursor !== undefined
        || !query.includeInactive) throw new SessionListCredentialScopeDeniedError();
    const readIds = async (tx: Tx) => {
        const ids = await readSessionManagedSubtreeSessionIdsInTx(tx, {
            accountId: params.userId, rootSessionId: principal.sessionId, authentication: params.authentication,
            allowSessionRuntimeManagedSubtreeRead: true,
        });
        if (!ids.includes(principal.sessionId)) throw new SessionListCredentialScopeDeniedError();
        return ids;
    };
    const viewAccess = (sessionId: string) => projectSessionRuntimeManagedSubtreeAccess({ accountId: params.userId, sessionId });
    return await captureSessionListingSnapshot(async tx => {
        const ids = await readIds(tx);
        const source: SessionListReadSource = { kind: 'effective', reader: tx,
            accessMode: 'effective_access_v1', baseWhere: conjoinSessionListWhereInputs(
                { id: { in: ids } }, createSessionListStorageWhere(query.storage), params.rowRepresentabilityWhere),
        };
        const cursor = query.cursor ? await resolveV2SessionListCursorForVisibleRows({ userId: params.userId,
            cursor: query.cursor, cursorRowWhere: {}, source }) : undefined;
        if (cursor === null) throw new SessionListInvalidCursorError();
        const rows = await findV2SessionListRows({ userId: params.userId, source, cursor,
            orderBy: V2_SESSION_LIST_ORDER_BY, take: (query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT) + 1 });
        const page = createV2SessionListRowPage({ rows, limit: query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT });
        const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, tx);
        const sessions = [];
        let metadataUpgradeRequiredCount = 0;
        for (const row of page.rows) {
            try {
                const { share: _share, ...session } = mapV2SessionCompactListRow({ row, userId: params.userId, ownerAccountModes,
                    omitViewer: true, effectiveAccess: viewAccess(row.id) });
                sessions.push(session);
            } catch (error) {
                if (!isSessionMetadataPrivacyUpgradeRequiredError(error)) throw error;
                metadataUpgradeRequiredCount += 1;
            }
        }
        return SessionRuntimeManagedSubtreeListResponseV1Schema.parse({ sessions, nextCursor: page.nextCursor, hasNext: page.hasNext,
            attentionNextCursor: null, attentionHasNext: false,
            ...(metadataUpgradeRequiredCount ? { metadataUpgradeRequiredCount } : {}) });
    });
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
    observedAttentionFailureSequences?: ReadonlyMap<string, number | null>;
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
        const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, rows, params.observedAttentionFailureSequences);
        const ruleReadStates = await loadSessionRuleReadStatesInTx(params.readSource?.discussionReader ?? db,
            { accountId: userId, authentication: params.authentication, rows, ruleRows: params.readSource?.ruleRows });
        return timing.measure("page", () => ({ ...mapV2SessionListRows({
            rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts, latestFailureSequences, ruleReadStates,
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
        const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, page.rows, params.observedAttentionFailureSequences);
        const ruleReadStates = await loadSessionRuleReadStatesInTx(params.readSource?.discussionReader ?? db,
            { accountId: userId, authentication: params.authentication, rows: page.rows, ruleRows: params.readSource?.ruleRows });
        return {
            ...mapV2SessionListRows({
                rows: page.rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts, latestFailureSequences, ruleReadStates,
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
    const page = await timing.measureAsync("query", async () => params.rowAdmission
        ? await findV2SessionListCandidatePage({
            userId, where, cursor, ...readAdmission, orderBy: V2_SESSION_LIST_ORDER_BY, limit,
            candidateLimit: resolveV2SessionListCandidateWindowLimit(Boolean(params.cursor)),
            rowAdmission: params.rowAdmission, onCandidatesExamined: timing.recordCandidates,
        })
        : createV2SessionListRowPage({ rows: await findV2SessionListRows({
            userId, where, cursor, ...readAdmission, orderBy: V2_SESSION_LIST_ORDER_BY, take: limit + 1,
        }), limit }));
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
            readLatestFailureSequences: (pageRows) => loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, pageRows, params.observedAttentionFailureSequences),
            readRuleReadStates: (pageRows) => loadSessionRuleReadStatesInTx(params.readSource?.discussionReader ?? db,
                { accountId: userId, authentication: params.authentication, rows: pageRows, ruleRows: params.readSource?.ruleRows }),
            pageRows: page.rows,
            page,
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
    const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, metadataReader);
    const discussionFacts = await readSessionListViewerDiscussionFacts(
        page.rows,
        userId,
        params.readSource?.discussionReader,
        params.observedAttentionDiscussionFacts,
    );
    const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(page.rows, userId, params.readSource?.discussionReader);
    const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, page.rows, params.observedAttentionFailureSequences);
    const ruleReadStates = await loadSessionRuleReadStatesInTx(params.readSource?.discussionReader ?? db,
        { accountId: userId, authentication: params.authentication, rows: page.rows, ruleRows: params.readSource?.ruleRows });
    return timing.measure("page", () => ({
        ...mapV2SessionListRows({
            rows: page.rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts, latestFailureSequences, ruleReadStates,
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
    const membershipFilter = query.membership?.mode === 'filter_or_manual' ? query.membership.filter : undefined;
    const followingAvailable = (query.scope === 'following' || membershipFilter?.scope === 'following')
        ? await isServerFeatureEnabledForHome('sessions.following') : true;
    const collaborationAvailable = isSessionCollaborationEnabled();
    if (query.scope === "following" && !followingAvailable) {
        throw new SessionListUnavailableQueryError("following");
    }
    if (query.audiences.some((audience) => audience.kind !== "outside_teams")
        && !collaborationAvailable) {
        throw new SessionListUnavailableQueryError("audience");
    }

    return await captureSessionListingSnapshot(async (tx) => await params.timing.measureAsync("snapshot", async () => {
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
            scopeWhere = await createSessionListScopeWhere({ tx, accountId: params.userId, scope: query.scope });
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
        const attentionRowAdmission: SessionListRowAdmission | undefined = query.attention === "needs_my_attention"
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
        const ruleRows = await readAccountFollowRuleProjectionRowsInTx(tx, {
            accountId: params.userId, authentication: params.authentication,
            collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
        });
        const ruleReceiverCounts = projectAccountFollowRuleReceiverCounts(ruleRows);
        const admitCoordinators: SessionListRowAdmission = async rows => {
            const projected = await projectSessionManagerForRowsInTx(tx, {
                accountId: params.userId, authentication: params.authentication, sessions: rows,
                accessMode: 'effective_access_v1', collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                nowMs: now, ruleReceiverCounts,
            });
            const selected = new Set<string>();
            for (const row of projected) {
                const coordinator = deriveSessionCoordinatorV1(row);
                // The manager projection already admitted both sides of this
                // relation. Keep ordinary workers as their coordinator's context.
                if (coordinator === true || readSessionManagerSessionIdV1(row) !== null) selected.add(row.id);
            }
            return rows.filter(row => selected.has(row.id));
        };
        const outerRowAdmission: SessionListRowAdmission | undefined = query.coordinator === undefined ? attentionRowAdmission
            : async rows => admitCoordinators(attentionRowAdmission ? await attentionRowAdmission(rows) : rows);
        const outerAttentionAdmission: SessionListRowAdmission = query.coordinator === undefined ? admitAttentionRows
            : async rows => admitCoordinators(await admitAttentionRows(rows));
        let membershipUnavailableReason: SessionListUnavailableQueryError['reason'] | undefined;
        let smartWhere: Prisma.SessionWhereInput = { id: { in: [] } };
        if (membershipFilter) {
            if (membershipFilter.scope === 'following' && !followingAvailable) {
                membershipUnavailableReason = 'following';
            } else if (membershipFilter.audiences.some(audience => audience.kind !== 'outside_teams') && !collaborationAvailable) {
                membershipUnavailableReason = 'audience';
            } else {
                let smartScopeWhere: Prisma.SessionWhereInput | undefined;
                try {
                    smartScopeWhere = await createSessionListScopeWhere({ tx, accountId: params.userId, scope: membershipFilter.scope });
                } catch {
                    membershipUnavailableReason = 'scope';
                }
                if (smartScopeWhere) {
                    const smartAudienceWhere = await createApplicableAudienceWhere({
                        tx, accountId: params.userId, audiences: membershipFilter.audiences,
                        authentication: params.authentication,
                        collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                    });
                    const smartSubtreeWhere: Prisma.SessionWhereInput = membershipFilter.underSessionId
                        ? { id: { in: await readSessionManagedSubtreeSessionIdsInTx(tx, {
                            accountId: params.userId, rootSessionId: membershipFilter.underSessionId,
                            authentication: params.authentication,
                            collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                        }) } } : {};
                    smartWhere = conjoinSessionListWhereInputs(createFilteredSessionListWhere({
                        accountId: params.userId,
                        query: { v: 1, storage: query.storage, includeInactive: true, ...membershipFilter },
                        accessWhere: {}, scopeWhere: smartScopeWhere, audienceWhere: smartAudienceWhere,
                        attentionWhere: attentionQuery.candidateWhere,
                    }), smartSubtreeWhere);
                }
            }
        }
        const membership = query.membership;
        const membershipWhere: Prisma.SessionWhereInput | undefined = membership ? { OR: [
            smartWhere,
            membership.tagIds.length ? createSessionViewerTagWhere({ accountId: params.userId, tagIds: membership.tagIds })
                : { id: { in: [] } },
        ] } : undefined;
        const admitMembershipRows: SessionListRowAdmission | undefined = membership && membershipFilter
            && !membershipUnavailableReason && (membershipFilter.attention === 'needs_my_attention' || membershipFilter.coordinator)
            ? async rows => {
                const tags = await fetchSessionTagAssignmentsForAdmittedSessionsInTx(tx, params.userId, rows.map(row => row.id));
                const manualIds = new Set(rows.filter(row => tags.get(row.id)?.some(tag => membership.tagIds.includes(tag))).map(row => row.id));
                let smartRows = rows.filter(row => !manualIds.has(row.id));
                if (membershipFilter.attention === 'needs_my_attention') smartRows = [...await admitAttentionRows(smartRows)];
                if (membershipFilter.coordinator) smartRows = [...await admitCoordinators(smartRows)];
                const admittedIds = new Set(smartRows.map(row => row.id));
                return rows.filter(row => manualIds.has(row.id) || admittedIds.has(row.id));
            } : undefined;
        const rowAdmission: SessionListRowAdmission | undefined = admitMembershipRows
            ? async rows => {
                const admitted = await admitMembershipRows(rows);
                return outerRowAdmission ? await outerRowAdmission(admitted) : admitted;
            } : outerRowAdmission;
        const admitAttentionCandidates: SessionListRowAdmission = admitMembershipRows
            ? async rows => outerAttentionAdmission(await admitMembershipRows(rows)) : outerAttentionAdmission;
        const baseWhere = createFilteredSessionListWhere({
            accountId: params.userId,
            query,
            accessWhere,
            scopeWhere,
            audienceWhere,
            attentionWhere,
        });
        const subtreeWhere: Prisma.SessionWhereInput = query.underSessionId
            ? { id: { in: await readSessionManagedSubtreeSessionIdsInTx(tx, {
                accountId: params.userId,
                rootSessionId: query.underSessionId,
                authentication: params.authentication,
                collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
            }) } }
            : {};
        const readSource: SessionListReadSource = {
            kind: "effective",
            reader: tx,
            baseWhere: conjoinSessionListWhereInputs(baseWhere, membershipWhere, subtreeWhere, params.rowRepresentabilityWhere),
            baseWhereBranches: createSessionListScopeQueryBranches(scopeWhere).map(branch => conjoinSessionListWhereInputs(
                createFilteredSessionListWhere({ accountId: params.userId, query, accessWhere,
                    scopeWhere: branch, audienceWhere, attentionWhere }),
                membershipWhere, subtreeWhere, params.rowRepresentabilityWhere,
            )),
            accessMode: "effective_access_v1",
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
            discussionReader: tx,
            ruleRows,
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
            attentionRowAdmission: admitAttentionCandidates,
            observedAttentionDiscussionFacts: attentionQuery.observedDiscussionFacts,
            observedAttentionFailureSequences: attentionQuery.observedFailureSequences,
            now,
            rowRepresentabilityWhere: params.rowRepresentabilityWhere,
            timing: params.timing,
        });
        if (!page) return null;
        const tagAssignments = membership
            ? await fetchSessionTagAssignmentsForAdmittedSessionsInTx(tx, params.userId, page.sessions.map(row => row.id))
            : undefined;
        const sessions = await projectSessionManagerForRowsInTx(tx, {
                accountId: params.userId,
                authentication: params.authentication,
                sessions: page.sessions,
                accessMode: "effective_access_v1",
                collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                nowMs: now,
                ruleReceiverCounts,
            });
        return SessionListQueryResponseV1Schema.parse({
            sessions: tagAssignments ? sessions.map(session => ({ ...session,
                viewer: { ...session.viewer, tagIds: tagAssignments.get(session.id) ?? [] },
            })) : sessions,
            ...(membershipUnavailableReason ? { membershipUnavailableReason } : {}),
            nextCursor: page.nextCursor ?? null,
            hasNext: page.hasNext ?? false,
            attentionNextCursor: page.attentionNextCursor ?? null,
            attentionHasNext: page.attentionHasNext ?? false,
            ...(page.metadataUpgradeRequiredCount !== undefined
                ? { metadataUpgradeRequiredCount: page.metadataUpgradeRequiredCount }
                : {}),
        });
    }));
}
