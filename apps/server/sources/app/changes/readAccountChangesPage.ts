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

    // Each statement must see newly committed retention/access changes.
    // READ COMMITTED preserves those fresh phases on one admitted connection;
    // a repeatable snapshot would conceal the final changesFloor update.
    const readPage = async (read: <T>(operation: (tx: Tx) => Promise<T>) => Promise<T>) => {
        const account = await read(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }));
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
        }));
        // Retention advances the floor and removes rows atomically. Keep
        // this second, fresh read after rows, even within one transaction.
        const currentAccount = await read(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }));
        if (currentAccount && after < currentAccount.changesFloor) {
            return { status: 'cursor-gone', account: currentAccount, reason: 'cursor-behind-floor-after-rows' } as const;
        }
        const visibleRows = rows.filter(row => {
            if (row.kind === 'pluginDomain') return compatibility.supportsPluginDataProtocol;
            if (row.kind === 'machinePool') return compatibility.supportsMachinePoolChangeProtocol;
            if (row.kind === 'savedSecretResource') return compatibility.supportsSavedSecretResourceChangeProtocol;
            return true;
        });
        const pendingSessionIds = [...new Set(visibleRows.flatMap(row =>
            row.kind === 'session' && canProjectPendingExecutionRunTargets(row.hint) ? [row.entityId] : [],
        ))];
        const pendingTargets = pendingSessionIds.length === 0 ? [] : await read(tx => listQueuedExecutionRunPendingTargetsForSessions({
            accountId: userId, sessionIds: pendingSessionIds, reader: tx,
        }));
        const sessionChangeCursors = new Map<string, number>();
        const sessionAccessResolutions = [];
        if (compatibility.supportsSessionAccessWitnessProtocol) {
            for (const row of visibleRows) {
                const id = row.entityId.trim();
                // Only the latest cursor for an exact Session needs its
                // canonical access fact; advisory kinds do not grant access.
                if (row.kind === 'session' && id.length > 0) sessionChangeCursors.set(id, row.cursor);
            }
            // One batched access read for the page, not one per changed Session.
            const resolutions = sessionChangeCursors.size === 0 ? new Map()
                : await read(tx => resolveSessionHostReferencesForAuthenticationInTx({
                    tx, accountId: userId, targetIds: [...sessionChangeCursors.keys()],
                    authentication: input.readAuthentication(),
                }));
            for (const [id, cursor] of sessionChangeCursors) {
                sessionAccessResolutions.push({ sessionId: id, cursor,
                    resolution: resolutions.get(id) ?? { status: 'unavailable' as const },
                });
            }
        }
        return { status: 'ok', account, rows, visibleRows, pendingTargets,
            sessionAccessResolutions: compatibility.supportsSessionAccessWitnessProtocol ? sessionAccessResolutions : undefined,
        } as const;
    };
    // SQLite has no READ COMMITTED transaction: retain its separate fresh
    // phase snapshots. The domain decisions above remain one shared path.
    const page = getDbProviderFromEnv(process.env, 'postgres') === 'sqlite'
        ? await readPage(operation => inReadSnapshot(operation))
        : await inTx(tx => readPage(operation => operation(tx)), { readOnly: true, isolationLevel: 'ReadCommitted' });
    if (page.status === 'account-not-found') return page;
    if (page.status === 'cursor-gone') {
        return { status: 'cursor-gone', currentCursor: page.account.seq, changesFloor: page.account.changesFloor, reason: page.reason };
    }
    const { account, rows, visibleRows, pendingTargets, sessionAccessResolutions } = page;

    // A selected read only materializes the requested AccountChange kinds
    // and/or exact Session. Once that result is shorter than the requested
    // page, the Account snapshot proves every cursor through `account.seq`
    // was examined; advance directly instead of paging unrelated activity.
    // A full page retains its last row cursor so the next page cannot skip
    // another selected change.
    const nextCursor = hasSelection && rows.length < limit
        ? account.seq
        : rows.length > 0 ? rows[rows.length - 1]!.cursor : after;
    const pendingRunIdsBySessionId = new Map<string, string[]>();
    for (const target of pendingTargets) {
        const existing = pendingRunIdsBySessionId.get(target.sessionId);
        if (existing) existing.push(target.runId);
        else pendingRunIdsBySessionId.set(target.sessionId, [target.runId]);
    }
    // A Team authentication refusal is per Session, decided by the Session
    // access owner for this credential: that Session's entry is unavailable
    // (as the Session list omits it) and the rest of the Account feed stays
    // readable. Refusing the whole page would stall every change kind for a
    // credential that retrying cannot qualify.
    // An unavailable accepted method (Home outage, unreadable fact) is not a
    // refusal: access is indeterminate, and a witnessed `unavailable` would
    // purge the Session and advance the cursor past it. Never acknowledge
    // that page; the client's changes retry owner replays it.
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
                        pendingExecutionRunIds: pendingRunIdsBySessionId.get(row.entityId) ?? [],
                    }
                    : row.hint ?? null,
            };
        }),
        nextCursor,
        ...(sessionAccessWitness === undefined ? {} : { sessionAccessWitness }),
    } };
}
