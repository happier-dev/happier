import { isSessionPersonallyTrackedV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import { clearFulfilledAccountSessionFollowOnceInTx } from '@/app/session/follow/accountFollowService';
import { projectViewerReadStateV1, type ViewerReadStateV1 } from '@happier-dev/protocol/sessions';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { parseSessionFollowRulePhysicalKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { readAccountFollowRuleProjectionRowsInTx, type AccountFollowRuleProjectionRows } from '@/app/session/follow/accountFollowRuleService';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

import { db } from "@/storage/db";
import { inReadSnapshot, inTx, transactionResult, type TransactionResult, type Tx } from "@/storage/inTx";
import type { AccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { AccountStatus } from "@/storage/prisma";
import { assertSessionCapabilityInTx } from "@/app/session/access/sessionAccess";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import type { SessionCollectiveAccessSnapshot } from "@/app/session/access/sessionAccessWhere";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    type SessionTranscriptPublicationFields,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    findLatestUnreadAffectingMainTranscriptMessageSeq,
    normalizeReadSeq,
    resolveManualUnreadReadableSessionSeq,
} from "@/app/session/readCursor/manualUnreadBoundary";
import {
    resolveSessionReadCursorOperation,
    type SessionReadCursorOperation,
    type SessionReadCursorReadState,
} from "@/app/session/readCursor/resolveSessionReadCursorOperation";
import { markAccountChangesForSessionAccounts } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";

import {
    listActivelyFollowingAccountIdsInTx,
    resolveSessionFollowFactsInTx,
} from "./followFacts";

/**
 * `AccountSessionReadState` is the sole durable viewer-read owner (L09B-I1).
 *
 * Every rule that used to be spread across the shared Session column lives here:
 * absence means quiet, a frontier is clamped to the viewer-visible publication
 * ceiling, only owner creation, Follow entry and the viewer's own explicit
 * mark may seed a row, and a mutation touches exactly one Account.
 */

export type ViewerReadStateRow = Readonly<{
    lastViewedSessionSeq: number;
    unreadSince: Date | null;
}>;

type ReadStateClient = Pick<Tx, "accountSessionReadState">;
type SessionReader = Pick<Tx, "session" | "accountSessionFollow">;

export type SessionRuleReadStates = NonNullable<SessionViewerProjectionV1['ruleReadStates']>;
export type SessionRuleReadBoundary = Readonly<{
    ruleId: string;
    ruleVersion: number;
    createdAt: number;
    beforeInceptionSeq: number;
}>;

type SessionRuleReadRow = SessionTranscriptPublicationFields & Readonly<{
    id: string;
    seq: number;
    accountReadStates?: readonly Readonly<{ accountId: string; lastViewedSessionSeq: number; unreadSince: Date | null }>[];
}>;

/** Combines candidate boundaries with this read's actual viewer cursor and publication ceiling. */
export function projectSessionRuleReadStates(input: Readonly<{
    visibleSessionSeq: number;
    boundaries: readonly SessionRuleReadBoundary[];
    readState: ViewerReadStateV1;
}>): SessionRuleReadStates {
    const { visibleSessionSeq, readState } = input;
    const cursor = readState.state === 'tracking' ? readState.lastViewedSessionSeq : 0;
    const unreadSince = readState.state === 'tracking' ? readState.unreadSince : null;
    return input.boundaries.map(rule => {
        const boundary = Math.max(cursor, rule.beforeInceptionSeq);
        return { ruleId: rule.ruleId, ruleVersion: rule.ruleVersion,
            readState: projectViewerReadStateV1({ tracked: true, visibleSessionSeq, row: {
                lastViewedSessionSeq: boundary,
                unreadSince: visibleSessionSeq > boundary ? Math.max(unreadSince ?? rule.createdAt, rule.createdAt) : null,
            } }),
        };
    });
}

/**
 * Private rule inception supplies a read-only boundary even before that rule has
 * encountered a source. This projects candidates, never a filter match or an
 * enrollment: the authorized client chooses its exact matching rule version.
 * Message cutoffs are set reads per distinct inception, not per rule or Session.
 */
export async function loadSessionRuleReadBoundariesInTx(tx: Tx, input: Readonly<{
    accountId: string;
    authentication: SessionAccessAuthentication;
    sessionIds: readonly string[];
    ruleRows?: AccountFollowRuleProjectionRows;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
}>): Promise<ReadonlyMap<string, readonly SessionRuleReadBoundary[]>> {
    const result = new Map<string, readonly SessionRuleReadBoundary[]>();
    if (!input.sessionIds.length || input.authentication.sessionRuntimePrincipal
        || input.authentication.apiTokenGrant && isApiTokenGrantRestrictedV1(input.authentication.apiTokenGrant)) return result;
    const sessionIds = [...new Set(input.sessionIds)];
    const listed = input.ruleRows === undefined ? await readAccountFollowRuleProjectionRowsInTx(tx, input) : input.ruleRows;
    // The reserved-row owner admits Account mode before disclosing any rule facts.
    if (listed?.status !== 'listed') return result;
    const rules = listed.rows.flatMap(row => {
        const ruleId = parseSessionFollowRulePhysicalKeyV1(row.physicalKey);
        const rule = row.envelope;
        return ruleId !== null && rule?.receiver.kind === 'account' && rule.inception
            ? [{ ruleId, ruleVersion: rule.version, createdAt: rule.inception.createdAt }] : [];
    });
    const rulesByInception = new Map<number, typeof rules>();
    for (const rule of rules) {
        const group = rulesByInception.get(rule.createdAt) ?? [];
        group.push(rule);
        rulesByInception.set(rule.createdAt, group);
    }
    for (const [createdAt, inceptionRules] of rulesByInception) {
        const beforeBySession = new Map<string, number>();
        // Creation cutoff plus Prisma's OFFSET bind share the portable SQL budget.
        for (const ids of portableQueryChunks({ values: sessionIds, bindingsPerValue: 1, fixedBindings: 2 })) {
            const cutoffs = await tx.sessionMessage.groupBy({ by: ['sessionId'],
                where: { sessionId: { in: [...ids] }, createdAt: { lt: new Date(createdAt) } },
                _max: { seq: true },
            });
            for (const cutoff of cutoffs) beforeBySession.set(cutoff.sessionId, cutoff._max.seq ?? 0);
        }
        for (const sessionId of sessionIds) {
            result.set(sessionId, [...result.get(sessionId) ?? [], ...inceptionRules.map(rule => ({
                ...rule, beforeInceptionSeq: beforeBySession.get(sessionId) ?? 0,
            }))]);
        }
    }
    return result;
}

export async function loadSessionRuleReadStatesInTx(tx: Tx, input: Readonly<{
    accountId: string;
    authentication: SessionAccessAuthentication;
    rows: readonly SessionRuleReadRow[];
    ruleRows?: AccountFollowRuleProjectionRows;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
}>): Promise<ReadonlyMap<string, SessionRuleReadStates>> {
    const boundaries = await loadSessionRuleReadBoundariesInTx(tx, { ...input, sessionIds: input.rows.map(row => row.id) });
    return new Map(input.rows.flatMap(row => {
        const rules = boundaries.get(row.id);
        if (!rules) return [];
        const visibleSessionSeq = resolveVisibleSessionSeq(row);
        const existing = row.accountReadStates?.find(state => state.accountId === input.accountId);
        const readState = projectViewerReadState({ tracked: existing !== undefined, row: existing ?? null, visibleSessionSeq });
        return [[row.id, projectSessionRuleReadStates({ visibleSessionSeq, readState, boundaries: rules })] as const];
    }));
}

const SESSION_READ_CEILING_SELECT = {
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    seq: true,
    latestReadyEventSeq: true,
    latestTurnStatus: true,
} as const;

type SessionReadCeilingRow = SessionTranscriptPublicationFields & Readonly<{
    accountId: string;
    seq: number;
    latestReadyEventSeq: number | null;
    latestTurnStatus: string | null;
}>;

/** The publication-clamped sequence a viewer may legitimately claim to have read. */
export function resolveVisibleSessionSeq(session: SessionTranscriptPublicationFields & Readonly<{ seq?: number | null }>): number {
    return normalizeReadSeq(applySessionTranscriptPublicationCeilingToProjection(
        { seq: normalizeReadSeq(session.seq) ?? 0 },
        session,
    ).seq) ?? 0;
}

export async function readViewerReadStateRowInTx(
    tx: ReadStateClient,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<ViewerReadStateRow | null> {
    const row = await tx.accountSessionReadState.findUnique({
        where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
        select: { lastViewedSessionSeq: true, unreadSince: true },
    });
    return row ?? null;
}

/**
 * The one viewer projection. It hides a retained-but-inert cursor from an
 * untracked viewer here rather than relying on every surface to remember a
 * second check (§5.4).
 */
export function projectViewerReadState(params: Readonly<{
    tracked: boolean;
    row: ViewerReadStateRow | null;
    visibleSessionSeq: number;
}>): ViewerReadStateV1 {
    return projectViewerReadStateV1({
        tracked: params.tracked,
        row: params.row
            ? {
                lastViewedSessionSeq: params.row.lastViewedSessionSeq,
                unreadSince: params.row.unreadSince ? params.row.unreadSince.getTime() : null,
            }
            : null,
        visibleSessionSeq: params.visibleSessionSeq,
    });
}

/** Owner-or-active-Follow, resolved through the narrow Follow-fact port. */
export async function isSessionPersonallyTrackedInTx(
    tx: SessionReader,
    params: Readonly<{ accountId: string; sessionId: string; ownerAccountId: string }>,
): Promise<boolean> {
    if (params.ownerAccountId === params.accountId) return true;
    const followFacts = await resolveSessionFollowFactsInTx(tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
    });
    return isSessionPersonallyTrackedV1({
        ownerAccountId: params.ownerAccountId,
        viewerAccountId: params.accountId,
        followFacts,
    });
}


/**
 * Owner initialization, part of the canonical Session creation transaction. A
 * new Session starts caught up for its owner and quiet for everybody else.
 */
export async function initializeSessionOwnerReadStateInTx(
    tx: ReadStateClient,
    params: Readonly<{ accountId: string; sessionId: string; lastViewedSessionSeq?: number }>,
): Promise<void> {
    const lastViewedSessionSeq = normalizeReadSeq(params.lastViewedSessionSeq) ?? 0;
    await tx.accountSessionReadState.upsert({
        where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
        create: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            lastViewedSessionSeq,
            unreadSince: null,
        },
        update: {},
    });
}

/**
 * Seeds a fresh baseline at the current visible ceiling. Deliberately private:
 * a caller-selected tracking writer would be a second way to enroll somebody in
 * unread state, which is exactly the split-brain this lane removes.
 */
async function seedViewerReadStateAtCurrentCeilingInTx(
    tx: ReadStateClient & SessionReader,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<void> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: SESSION_READ_CEILING_SELECT,
    });
    if (!session) return;
    const lastViewedSessionSeq = resolveVisibleSessionSeq(session);
    await tx.accountSessionReadState.upsert({
        where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
        create: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            lastViewedSessionSeq,
            unreadSince: null,
        },
        update: { lastViewedSessionSeq, unreadSince: null },
    });
}

/**
 * The single tracking-entry seam. The Follow owner calls it inside its own
 * Follow transition transaction (§4.2). A cursor-only mark by a reader with no
 * frontier is not such a transition and seeds the main frontier directly.
 *
 * `wasTracked` is derived by the caller from the canonical predicate *before*
 * the relation write and is never trusted from a client: an already tracked
 * owner or follower keeps its frontier, while a genuinely new entry starts at
 * the then-current ceiling so re-following never replays the interval the
 * Account was away.
 */
export async function beginViewerReadTrackingOnFollowEntryInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sessionId: string;
    wasTracked: boolean;
    authentication?: SessionAccessAuthentication;
}>): Promise<void> {
    if (params.wasTracked) return;
    await seedViewerReadStateAtCurrentCeilingInTx(params.tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
    });
}


/**
 * The guarded non-unread transition (§5.3). It moves only cursors that were
 * already caught up at the pre-write ceiling, so an ordinary new message never
 * silently marks anybody read and a concurrent manual unread survives. It never
 * creates a row: an untracked Account stays untracked.
 */
export async function advanceCaughtUpViewerReadCursorsInTx(
    tx: ReadStateClient & SessionReader,
    params: Readonly<{ sessionId: string; previousVisibleSeq: number; nextVisibleSeq: number }>,
): Promise<number> {
    const previous = normalizeReadSeq(params.previousVisibleSeq) ?? 0;
    const next = normalizeReadSeq(params.nextVisibleSeq) ?? 0;
    if (next <= previous) return 0;
    const { count } = await tx.accountSessionReadState.updateMany({
        where: {
            sessionId: params.sessionId,
            accountId: { in: [...await listRelevantAccountIdsForSessionBadgeRefreshInTx(tx, params)] },
            account: { status: "active" },
            lastViewedSessionSeq: { gte: previous, lt: next },
        },
        data: { lastViewedSessionSeq: next, unreadSince: null },
    });
    return count;
}

/**
 * New unread-impact content stamps the private unread-entry instant of every
 * tracked viewer that is transitioning read → unread, without advancing any
 * cursor and without disturbing a viewer that was already unread.
 */
export async function stampViewerUnreadEntryInTx(
    tx: ReadStateClient & SessionReader,
    params: Readonly<{ sessionId: string; visibleSessionSeq: number; at: Date }>,
): Promise<number> {
    const visible = normalizeReadSeq(params.visibleSessionSeq) ?? 0;
    if (visible <= 0) return 0;
    const { count } = await tx.accountSessionReadState.updateMany({
        where: {
            sessionId: params.sessionId,
            unreadSince: null,
            accountId: { in: [...await listRelevantAccountIdsForSessionBadgeRefreshInTx(tx, params)] },
            account: { status: "active" },
            lastViewedSessionSeq: { lt: visible },
        },
        data: { unreadSince: params.at },
    });
    return count;
}

/**
 * Badge-refresh-only. It returns the Accounts with an exact current
 * owner-or-Follow tracking relation to one Session; it never classifies a
 * semantic event, selects notification recipients, or enumerates every Account
 * that can merely read the Session.
 */
export async function listRelevantAccountIdsForSessionBadgeRefreshInTx(
    tx: SessionReader,
    params: Readonly<{ sessionId: string }>,
): Promise<readonly string[]> {
    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: { accountId: true },
    });
    if (!session) return [];
    const following = await listActivelyFollowingAccountIdsInTx(tx, { sessionId: params.sessionId });
    return [...new Set([session.accountId, ...following])];
}

export async function listRelevantAccountIdsForSessionBadgeRefresh(
    sessionId: string,
): Promise<readonly string[]> {
    return await listRelevantAccountIdsForSessionBadgeRefreshInTx(db, { sessionId });
}

export type ViewerReadCursorOperationError =
    | "invalid-params"
    | "forbidden"
    | "session-not-found"
    | "session-not-tracked"
    | "internal";

export type ApplyViewerReadCursorOperationResult =
    | Readonly<{
        ok: true;
        accountId: string;
        lastViewedSessionSeq: number | null;
        unreadSince: Date | null;
        didChange: boolean;
        readState: SessionReadCursorReadState;
        viewerReadState: ViewerReadStateV1;
        visibleSessionSeq: number;
        /** AccountChange cursor for the actor only; never another Account's. */
        actorChangeCursor: number | null;
    }>
    | Readonly<{ ok: false; error: ViewerReadCursorOperationError }>;

type ViewerReadCursorSuccess = Extract<ApplyViewerReadCursorOperationResult, { ok: true }>;
export type ViewerReadCursorOperationInTxResult =
    | Extract<ApplyViewerReadCursorOperationResult, { ok: false }>
    | (Omit<ViewerReadCursorSuccess, "actorChangeCursor"> & TransactionResult<ViewerReadCursorSuccess>);

function isValidOperation(operation: SessionReadCursorOperation): boolean {
    if (operation.kind === "mark-read" || operation.kind === "mark-unread") return true;
    return operation.kind === "advance"
        && typeof operation.lastViewedSessionSeq === "number"
        && Number.isFinite(operation.lastViewedSessionSeq);
}

/**
 * Reader admission shared by every cursor operation: an active Account holding
 * `readTranscript` on an existing Session. It reports the owner-or-Follow
 * tracking fact and the viewer's own frontier row; each entry point decides
 * what a missing frontier means for its operation.
 */
async function admitViewerReadCursorOperation(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string; authentication: SessionAccessAuthentication }>,
): Promise<
    | Readonly<{ ok: true; session: SessionReadCeilingRow; tracked: boolean; current: ViewerReadStateRow | null }>
    | Readonly<{ ok: false; error: ViewerReadCursorOperationError }>
> {
    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: { status: true },
    });
    if (!account) return { ok: false, error: "forbidden" };
    if (account.status !== AccountStatus.active) return { ok: false, error: "forbidden" };

    const capability = await assertSessionCapabilityInTx({
        tx,
        accountId: params.accountId,
        sessionId: params.sessionId,
        capability: "readTranscript",
        authentication: params.authentication,
    });
    if (!capability.ok) return { ok: false, error: "forbidden" };

    const session = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: SESSION_READ_CEILING_SELECT,
    });
    if (!session) return { ok: false, error: "session-not-found" };

    const tracked = await isSessionPersonallyTrackedInTx(tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
        ownerAccountId: session.accountId,
    });
    const current = await readViewerReadStateRowInTx(tx, { accountId: params.accountId, sessionId: params.sessionId });
    return { ok: true, session, tracked, current };
}

/**
 * The one actor-scoped read mutation (§5.3).
 *
 * Read authority is `readTranscript`, not edit: a view-only collaborator owns
 * its own frontier. An explicit human mark-read/mark-unread is that reader's
 * own enrolment: for a reader with no frontier yet it seeds only that Account's
 * row at the current ceiling (the same fresh baseline Follow entry uses) before
 * applying the operation. Automatic viewport advances never create a frontier,
 * and owner-or-active-Follow is still what admits automatic stamping, badge
 * refresh, attention and delivery, so no cursor write can enroll an Account in
 * somebody else's unread state and no broad recipient fanout is reachable here.
 */
export async function applyViewerReadCursorOperation(params: Readonly<{
    accountId: string;
    sessionId: string;
    operation: SessionReadCursorOperation;
    authentication: SessionAccessAuthentication;
}>): Promise<ApplyViewerReadCursorOperationResult> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const accountId = typeof params.accountId === "string" ? params.accountId : "";
    const operation = params.operation;
    if (!sessionId || !accountId || !operation || !isValidOperation(operation)) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        let latestMainMessageSeq: number | null = null;
        let initialVisibleSeq: number | null = null;
        if (operation.kind === "mark-unread") {
            const initial = await inReadSnapshot(async (tx) => await admitViewerReadCursorOperation(tx, { accountId, sessionId, authentication: params.authentication }));
            if (!initial.ok) return initial;
            initialVisibleSeq = resolveVisibleSessionSeq(initial.session);
            latestMainMessageSeq = await findLatestUnreadAffectingMainTranscriptMessageSeq(
                sessionId,
                initial.session,
            );
        }

        return await inTx(async (tx) => {
            // Follow entry and this reader's frontier share the existing Account
            // publication fence, acquired before baseline/tracking admission.
            await acquireSessionAccountCursorLocksInTx(tx, [sessionId], [accountId]);
            if (operation.kind !== "advance") {
                const admitted = await admitViewerReadCursorOperation(tx, { accountId, sessionId, authentication: params.authentication });
                if (!admitted.ok) return admitted;
                if (admitted.current === null) {
                    // A cursor-only mark is not a Follow transition: it gives this reader
                    // its own main frontier and nothing else. The combined tracking entry,
                    // which also baselines every Discussion cursor, stays reserved for the
                    // Follow owner that can prove an inactive-to-active transition.
                    await seedViewerReadStateAtCurrentCeilingInTx(tx, { accountId, sessionId });
                }
            }
            return await applyViewerReadCursorOperationInTx(tx, {
                accountId, sessionId, operation, latestMainMessageSeq, initialVisibleSeq, authentication: params.authentication,
            });
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}

/**
 * The transaction-local cursor owner, also consumed by composed writers (the
 * released metadata hint adapter, reminder placement). It moves an existing
 * frontier only: a composed request never fabricates a baseline, so an
 * untracked reader without one is simply not enrolled, and a tracked
 * owner/follower without one is a missing lifecycle write.
 */
export async function applyViewerReadCursorOperationInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string;
        operation: SessionReadCursorOperation;
        authentication: SessionAccessAuthentication;
        /** Canonical main-transcript scan, prepared outside the mutation transaction. */
        latestMainMessageSeq?: number | null;
        initialVisibleSeq?: number | null;
    }>,
): Promise<ViewerReadCursorOperationInTxResult> {
    const { accountId, sessionId, operation, latestMainMessageSeq = null, initialVisibleSeq = null } = params;
    const admission = await admitViewerReadCursorOperation(tx, { accountId, sessionId, authentication: params.authentication });
    if (!admission.ok) return admission;
    const { session, tracked, current } = admission;
    const visibleSessionSeq = resolveVisibleSessionSeq(session);
    if (current === null) return { ok: false, error: tracked ? "internal" : "session-not-tracked" };

    const conservativeMainMessageSeq = operation.kind === "mark-unread"
        && typeof initialVisibleSeq === "number"
        && visibleSessionSeq > initialVisibleSeq
        ? visibleSessionSeq
        : latestMainMessageSeq;
    const readableSessionSeq = operation.kind === "mark-unread"
        ? resolveManualUnreadReadableSessionSeq(conservativeMainMessageSeq, session)
        : undefined;

    const currentCursor = Math.min(current.lastViewedSessionSeq, visibleSessionSeq);
    const resolved = resolveSessionReadCursorOperation({
        sessionSeq: visibleSessionSeq,
        readableSessionSeq,
        currentLastViewedSessionSeq: currentCursor,
        operation,
    });
    const nextCursor = resolved.nextLastViewedSessionSeq;
    const onceCleared = operation.kind === 'mark-read'
        && await clearFulfilledAccountSessionFollowOnceInTx(tx, { accountId, sessionId });

    const buildResult = (
        row: ViewerReadStateRow | null,
        didChange: boolean,
        publication?: AccountChangePublication,
    ): Extract<ViewerReadCursorOperationInTxResult, { ok: true }> => {
        const result = {
            ok: true as const,
            accountId,
            lastViewedSessionSeq: row ? Math.min(row.lastViewedSessionSeq, visibleSessionSeq) : null,
            unreadSince: row?.unreadSince ?? null,
            didChange,
            readState: resolved.readState,
            viewerReadState: projectViewerReadState({ tracked: true, row, visibleSessionSeq }),
            visibleSessionSeq,
        };
        return { ...result, ...transactionResult(() => ({ ...result, actorChangeCursor: publication?.resolveCursor() ?? null })) };
    };

    // Actor-private wake. Cross-device convergence for the same Account
    // uses the existing AccountChange/user-room delivery; no other
    // Account's socket learns this frontier (L09B-I4).
    const markActorChanged = async (nextLastViewedSessionSeq: number): Promise<AccountChangePublication | undefined> => {
        const [publication] = await markAccountChangesForSessionAccounts({
            tx,
            sessionId,
            accountIds: [accountId],
            hint: { lastViewedSessionSeq: nextLastViewedSessionSeq },
        });
        return publication;
    };

    if (!resolved.didChange || typeof nextCursor !== "number") {
        return buildResult(current, onceCleared);
    }

    const unreadSince = nextCursor >= visibleSessionSeq
        ? null
        : operation.kind === "mark-unread"
            ? new Date()
            : current.unreadSince ?? new Date();

    const { count } = await tx.accountSessionReadState.updateMany({
        where: operation.kind === "mark-unread"
            ? { accountId, sessionId, lastViewedSessionSeq: { gt: nextCursor } }
            : { accountId, sessionId, lastViewedSessionSeq: { lt: nextCursor } },
        data: { lastViewedSessionSeq: nextCursor, unreadSince },
    });
    if (count === 0) {
        // Compare-and-set lost to a newer frontier from another device of
        // the same Account; report the current truth instead of regressing it.
        const fresh = await readViewerReadStateRowInTx(tx, { accountId, sessionId });
        return buildResult(fresh, false);
    }
    return buildResult(
        { lastViewedSessionSeq: nextCursor, unreadSince },
        true,
        await markActorChanged(nextCursor),
    );
}
