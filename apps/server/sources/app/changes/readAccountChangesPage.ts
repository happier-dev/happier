import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/config/databaseProvider";
import type { AccountStoredContentCompatibilityEvaluation } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveSessionHostReferencesForAuthenticationInTx } from "@/app/session/pluginCollectionHostReferenceAdapter";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { listQueuedExecutionRunPendingTargetsForSessions } from "@/app/session/pending/pendingMessageService";
import { readAuthoritativeSessionDeletionChangeV1, type ChangesResponse } from '@happier-dev/protocol/changes';

function isPendingStateChangeHint(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const hint = value as Record<string, unknown>;
    return typeof hint.pendingCount === "number"
        && Number.isSafeInteger(hint.pendingCount)
        && hint.pendingCount >= 0
        && typeof hint.pendingVersion === "number"
        && Number.isSafeInteger(hint.pendingVersion)
        && hint.pendingVersion >= 0;
}

function canProjectPendingExecutionRunTargets(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const hint = value as Record<string, unknown>;
    return !(hint.v === 1 && hint.lifecycle === "deleted");
}

/** One committed AccountChange row as stored (the feed reads it; a publishing write returns it). */
export type AccountChangeRowFacts = Readonly<{ cursor: number; kind: string; entityId: string; changedAt: Date; hint: unknown }>;

type SessionAccessResolutionEntry = Readonly<{
    sessionId: string;
    cursor: number;
    resolution: Readonly<{ status: string }>;
}>;

/** Kinds this peer's stored-content compatibility cannot consume are hidden. */
export function isAccountChangeRowVisibleToCompatibility(
    row: Pick<AccountChangeRowFacts, 'kind'>, compatibility: AccountStoredContentCompatibilityEvaluation,
): boolean {
    if (row.kind === 'pluginDomain') return compatibility.supportsPluginDataProtocol;
    if (row.kind === 'machinePool') return compatibility.supportsMachinePoolChangeProtocol;
    if (row.kind === 'savedSecretResource') return compatibility.supportsSavedSecretResourceChangeProtocol;
    return true;
}

/**
 * Account-wide facts of these rows, the same for every credential: queued execution-run ids per
 * changed Session (one read). The feed and the wake fan-out both read them here.
 */
export async function readAccountChangeRowsPendingRunIds(
    reader: Tx, accountId: string, rows: readonly AccountChangeRowFacts[],
): Promise<ReadonlyMap<string, string[]>> {
    const sessionIds = [...new Set(rows.flatMap(row =>
        row.kind === 'session' && canProjectPendingExecutionRunTargets(row.hint) ? [row.entityId] : []))];
    const pendingRunIdsBySessionId = new Map<string, string[]>();
    if (sessionIds.length === 0) return pendingRunIdsBySessionId;
    for (const target of await listQueuedExecutionRunPendingTargetsForSessions({ accountId, sessionIds, reader })) {
        const existing = pendingRunIdsBySessionId.get(target.sessionId);
        if (existing) existing.push(target.runId);
        else pendingRunIdsBySessionId.set(target.sessionId, [target.runId]);
    }
    return pendingRunIdsBySessionId;
}

/**
 * One credential's access to the Sessions these (already visible) rows name: the Session access
 * owner's batched decision, one read for the rows, not one per changed Session. Only the latest
 * cursor for an exact Session needs its canonical access fact; advisory kinds do not grant access.
 */
export async function readAccountChangeRowsSessionAccess(
    reader: Tx, accountId: string, visibleRows: readonly AccountChangeRowFacts[],
    authentication: () => SessionAccessAuthentication,
): Promise<readonly SessionAccessResolutionEntry[]> {
    const sessionChangeCursors = new Map<string, number>();
    for (const row of visibleRows) {
        const id = row.entityId.trim();
        if (row.kind === 'session' && id.length > 0) sessionChangeCursors.set(id, row.cursor);
    }
    if (sessionChangeCursors.size === 0) return [];
    const resolutions = await resolveSessionHostReferencesForAuthenticationInTx({
        tx: reader, accountId, targetIds: [...sessionChangeCursors.keys()], authentication: authentication(),
    });
    return [...sessionChangeCursors].map(([sessionId, cursor]) => ({ sessionId, cursor,
        resolution: resolutions.get(sessionId) ?? { status: 'unavailable' as const } }));
}

/**
 * Runs the change-feed reads on one admitted connection. Each statement must see newly committed
 * retention/access changes: READ COMMITTED preserves those fresh phases on PostgreSQL (a repeatable
 * snapshot would conceal the final changesFloor update). SQLite has no READ COMMITTED transaction,
 * so each phase is its own fresh snapshot; single-statement phases need no frame.
 */
export async function withAccountChangesReads<T>(
    run: (read: <R>(operation: (tx: Tx) => Promise<R>, singleStatement?: boolean) => Promise<R>) => Promise<T>,
): Promise<T> {
    return getDbProviderFromEnv(process.env, 'postgres') === 'sqlite'
        ? run((operation, singleStatement) => inReadSnapshot(operation, singleStatement ? { singleStatementRead: true } : undefined))
        : inTx(tx => run(operation => operation(tx)), { readOnly: true, isolationLevel: 'ReadCommitted' });
}

/**
 * Projects visible rows into the page one credential sees. A Team authentication refusal is per
 * Session: that Session's entry is unavailable (as the Session list omits it) and the rest of the
 * feed stays readable. An unavailable accepted method (Home outage, unreadable fact) is not a
 * refusal: access is indeterminate, and a witnessed `unavailable` would purge the Session and
 * advance the cursor past it, so that page is never acknowledged (`authentication-unavailable`).
 */
export function projectAccountChangesPage(input: Readonly<{
    visibleRows: readonly AccountChangeRowFacts[];
    nextCursor: number;
    /** More rows may follow `nextCursor` (judged on the stored rows, before any filter). */
    full: boolean;
    pendingRunIdsBySessionId: ReadonlyMap<string, readonly string[]>;
    /** Undefined when the peer does not consume the Session access witness. */
    sessionAccessResolutions: readonly SessionAccessResolutionEntry[] | undefined;
}>): Exclude<AccountChangesPageRead, Readonly<{ status: 'account-not-found' | 'cursor-gone' }>> {
    const { visibleRows, nextCursor, sessionAccessResolutions } = input;
    if (sessionAccessResolutions?.some(({ resolution }) => resolution.status === 'authentication_unavailable')) {
        return { status: 'authentication-unavailable' };
    }
    const unavailableSessionIds = new Set(sessionAccessResolutions?.flatMap(({ sessionId: id, resolution }) =>
        resolution.status === 'available' ? [] : [id]) ?? []);
    const sessionAccessWitness = sessionAccessResolutions !== undefined
        ? {
            v: 1 as const,
            throughCursor: nextCursor,
            entries: sessionAccessResolutions.map(({ sessionId: id, cursor, resolution }) => ({
                sessionId: id,
                cursor,
                status: resolution.status === 'available' ? 'available' as const : 'unavailable' as const,
            })),
        }
        : undefined;
    return { status: 'ok', page: {
        changes: visibleRows.map((row) => {
            const base = { cursor: row.cursor, kind: row.kind, entityId: row.entityId, changedAt: row.changedAt.getTime() };
            if (row.kind === 'session' && unavailableSessionIds.has(row.entityId.trim())) {
                // The access-loss event itself: only an authoritative deletion fact survives.
                const deletion = readAuthoritativeSessionDeletionChangeV1({ ...base, hint: row.hint ?? null });
                return { ...base, hint: deletion ? row.hint : null };
            }
            return { ...base,
                hint: row.kind === 'session' && canProjectPendingExecutionRunTargets(row.hint)
                    ? {
                        ...(isPendingStateChangeHint(row.hint) || (row.hint && typeof row.hint === 'object' && !Array.isArray(row.hint))
                            ? row.hint
                            : {}),
                        pendingExecutionRunIds: input.pendingRunIdsBySessionId.get(row.entityId) ?? [],
                    }
                    : row.hint ?? null,
            };
        }),
        nextCursor,
        full: input.full,
        ...(sessionAccessWitness === undefined ? {} : { sessionAccessWitness }),
    } };
}

export type AccountChangesPageRead =
    | Readonly<{ status: 'account-not-found' }>
    | Readonly<{ status: 'cursor-gone'; currentCursor: number; changesFloor: number;
        reason: 'cursor-in-future' | 'cursor-behind-floor' | 'cursor-behind-floor-after-rows' }>
    /** Access is indeterminate for this credential (Home outage, unreadable fact): never acknowledge. */
    | Readonly<{ status: 'authentication-unavailable' }>
    | Readonly<{ status: 'ok'; page: ChangesResponse }>;

/**
 * The one Account change-feed page owner: `GET /v2/changes` and the Account wake
 * fan-out read the page a credential may see through this function, so a pushed
 * page is exactly the page that credential would read.
 *
 * Visibility is decided here, per credential: stored-content compatibility hides
 * kinds the peer cannot consume, and the Session access owner resolves each
 * changed Session for this credential. A Session it cannot reach keeps its row
 * as the access-loss event (cursor, witness `unavailable`, and an authoritative
 * deletion fact when that is what happened) but carries none of the Session's
 * change facts.
 */
export async function readAccountChangesPage(input: Readonly<{
    accountId: string;
    after: number;
    limit: number;
    /** Selected kinds (a selected read certifies every cursor through the Account snapshot). */
    kinds?: readonly string[];
    sessionId?: string;
    compatibility: AccountStoredContentCompatibilityEvaluation;
    readAuthentication: () => SessionAccessAuthentication;
}>): Promise<AccountChangesPageRead> {
    const { accountId: userId, after, limit, sessionId, compatibility } = input;
    const selectedKinds = input.kinds;
    const hasSelection = selectedKinds !== undefined;

    const readPage = async (read: <T>(operation: (tx: Tx) => Promise<T>, singleStatement?: boolean) => Promise<T>) => {
        const account = await read(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), true);
        if (!account) return { status: 'account-not-found' } as const;
        if (after > account.seq) return { status: 'cursor-gone', account, reason: 'cursor-in-future' } as const;
        if (after < account.changesFloor) return { status: 'cursor-gone', account, reason: 'cursor-behind-floor' } as const;

        const rows = await read(tx => tx.accountChange.findMany({
            where: {
                accountId: userId,
                cursor: { gt: after, ...(hasSelection ? { lte: account.seq } : {}) },
                ...(sessionId === undefined ? {} : { entityId: sessionId }),
                ...(selectedKinds === undefined ? {} : { kind: { in: [...selectedKinds] } }),
            },
            orderBy: [{ cursor: 'asc' }, { kind: 'asc' }, { entityId: 'asc' }],
            take: limit,
            select: { cursor: true, kind: true, entityId: true, changedAt: true, hint: true },
        }), true);
        // Retention advances the floor and removes rows atomically. Keep
        // this second, fresh read after rows, even within one transaction.
        const currentAccount = await read(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), true);
        if (currentAccount && after < currentAccount.changesFloor) {
            return { status: 'cursor-gone', account: currentAccount, reason: 'cursor-behind-floor-after-rows' } as const;
        }
        const visibleRows = rows.filter(row => isAccountChangeRowVisibleToCompatibility(row, compatibility));
        const pendingRunIdsBySessionId = await read(tx => readAccountChangeRowsPendingRunIds(tx, userId, visibleRows), true);
        const sessionAccessResolutions = compatibility.supportsSessionAccessWitnessProtocol
            ? await read(tx => readAccountChangeRowsSessionAccess(tx, userId, visibleRows, input.readAuthentication))
            : undefined;
        return { status: 'ok', account, rows, visibleRows, pendingRunIdsBySessionId, sessionAccessResolutions } as const;
    };
    const page = await withAccountChangesReads(readPage);
    if (page.status === 'account-not-found') return page;
    if (page.status === 'cursor-gone') {
        return { status: 'cursor-gone', currentCursor: page.account.seq, changesFloor: page.account.changesFloor, reason: page.reason };
    }
    const { account, rows } = page;

    // `full` is judged on the stored rows the page read, before the compatibility filter: a page
    // the filter shortened still has more rows after `nextCursor`, and its reader must read on.
    // A selected read only materializes the requested AccountChange kinds
    // and/or exact Session. Once that result is shorter than the requested
    // page, the Account snapshot proves every cursor through `account.seq`
    // was examined; advance directly instead of paging unrelated activity.
    // A full page retains its last row cursor so the next page cannot skip
    // another selected change.
    const full = rows.length >= limit;
    const nextCursor = hasSelection && !full
        ? account.seq
        : rows.length > 0 ? rows[rows.length - 1]!.cursor : after;
    return projectAccountChangesPage({ visibleRows: page.visibleRows, nextCursor, full,
        pendingRunIdsBySessionId: page.pendingRunIdsBySessionId, sessionAccessResolutions: page.sessionAccessResolutions });
}
