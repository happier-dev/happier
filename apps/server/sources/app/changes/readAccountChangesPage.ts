import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/config/databaseProvider";
import type { AccountStoredContentCompatibilityEvaluation } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveSessionHostReferencesForAuthenticationInTx } from "@/app/session/pluginCollectionHostReferenceAdapter";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { listQueuedExecutionRunPendingTargetsForSessions } from "@/app/session/pending/pendingMessageService";
import { ChangeKindSchema, readAuthoritativeSessionDeletionChangeV1, type ChangesResponse } from '@happier-dev/protocol/changes';
import { isPairedProviderAccountUsageChangeV1 } from '@happier-dev/protocol/changes/providerAccountUsage';

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
        // Reads return caller data, never a write's TransactionResult (the inReadSnapshot shape).
        : (await inTx(async tx => ({ value: await run(operation => operation(tx)) }), { readOnly: true, isolationLevel: 'ReadCommitted' })).value;
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
    /** More rows may follow `nextCursor`. Omitted on the released HTTP envelope. */
    full?: boolean;
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
        ...(input.full === undefined ? {} : { full: input.full }),
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
    // The same V4 declaration admits the additive change-feed response fields.
    // Released readers reject those fields and drain by the requested row count.
    const supportsFull = compatibility.supportsSessionAccessWitnessProtocol;
    const readThroughSnapshot = selectedKinds !== undefined || !supportsFull;
    // Fill a legacy page with visible rows so its length still signals exhaustion.
    const hiddenKinds = supportsFull ? [] : ChangeKindSchema.options.filter(kind => !isAccountChangeRowVisibleToCompatibility({ kind }, compatibility));
    const kindFilter = selectedKinds === undefined && hiddenKinds.length === 0 ? {} : { kind: {
        ...(selectedKinds === undefined ? {} : { in: [...selectedKinds] }),
        ...(hiddenKinds.length === 0 ? {} : { notIn: hiddenKinds }),
    } };

    const readPage = async (read: <T>(operation: (tx: Tx) => Promise<T>, singleStatement?: boolean) => Promise<T>) => {
        const account = await read(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), true);
        if (!account) return { status: 'account-not-found' } as const;
        if (after > account.seq) return { status: 'cursor-gone', account, reason: 'cursor-in-future' } as const;
        if (after < account.changesFloor) return { status: 'cursor-gone', account, reason: 'cursor-behind-floor' } as const;

        const readRows = await read(tx => tx.accountChange.findMany({
            where: {
                accountId: userId,
                cursor: { gt: after, ...(readThroughSnapshot ? { lte: account.seq } : {}) },
                ...(sessionId === undefined ? {} : { entityId: sessionId }),
                ...kindFilter,
            },
            orderBy: [{ cursor: 'asc' }, { kind: 'asc' }, { entityId: 'asc' }],
            take: supportsFull ? limit + 1 : limit,
            select: { cursor: true, kind: true, entityId: true, changedAt: true, hint: true },
        }), true);
        const last = readRows[limit - 1];
        const next = readRows[limit];
        // Never acknowledge only the legacy/global half of a verified quota
        // pair to a V4 reader. Defer the pair together, or carry it on a
        // one-row HTTP page. Released readers keep their original row boundary.
        const splitQuotaPair = last && next && isPairedProviderAccountUsageChangeV1(last, next);
        const rows = readRows.slice(0, splitQuotaPair ? limit === 1 ? 2 : limit - 1 : limit);
        const full = readRows.length >= limit;
        // Retention advances the floor and removes rows atomically. Keep
        // this second, fresh read after rows, even within one transaction.
        const currentAccount = await read(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), true);
        if (currentAccount && after < currentAccount.changesFloor) {
            return { status: 'cursor-gone', account: currentAccount, reason: 'cursor-behind-floor-after-rows' } as const;
        }
        const visibleRows = supportsFull ? rows.filter(row => isAccountChangeRowVisibleToCompatibility(row, compatibility)) : rows;
        const pendingRunIdsBySessionId = await read(tx => readAccountChangeRowsPendingRunIds(tx, userId, visibleRows), true);
        const sessionAccessResolutions = compatibility.supportsSessionAccessWitnessProtocol
            ? await read(tx => readAccountChangeRowsSessionAccess(tx, userId, visibleRows, input.readAuthentication))
            : undefined;
        return { status: 'ok', account, rows, full, visibleRows, pendingRunIdsBySessionId, sessionAccessResolutions } as const;
    };
    const page = await withAccountChangesReads(readPage);
    if (page.status === 'account-not-found') return page;
    if (page.status === 'cursor-gone') {
        return { status: 'cursor-gone', currentCursor: page.account.seq, changesFloor: page.account.changesFloor, reason: page.reason };
    }
    const { account, rows, full } = page;

    // V4 can continue after a short projected page using `full`. Legacy reads
    // and selected reads cover a captured Account snapshot. Once their read
    // exhausts matching rows, it can acknowledge through that snapshot, even
    // with a hidden tail. A full page acknowledges only its last returned row.
    const nextCursor = readThroughSnapshot && !full
        ? account.seq
        : rows.length > 0 ? rows[rows.length - 1]!.cursor : after;
    return projectAccountChangesPage({ visibleRows: page.visibleRows, nextCursor, ...(supportsFull ? { full } : {}),
        pendingRunIdsBySessionId: page.pendingRunIdsBySessionId, sessionAccessResolutions: page.sessionAccessResolutions });
}
