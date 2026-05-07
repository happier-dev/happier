import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import {
    planSyncActionsFromChanges,
    type PlannedChangeActions,
    type UnsupportedChangeMarker,
} from './changesPlanner';

export type FetchChangesFn = (params: {
    credentials: AuthCredentials;
    afterCursor: string | null;
    limit: number;
}) => Promise<
    | { status: 'ok'; changes: ChangeEntry[]; nextCursor: string }
    | { status: 'cursor-gone'; currentCursor: string }
    | { status: 'error' }
>;

export type FetchCurrentChangesCursorFn = (params: {
    credentials: AuthCredentials;
}) => Promise<{ status: 'ok'; cursor: string } | { status: 'error' }>;

export type SnapshotRefreshResult = { status: 'complete' } | { status: 'partial' } | { status: 'error' };

export type PlannedChangesApplyResult =
    | void
    | { status: 'complete'; safeAdvanceCursor?: string | null }
    | {
        status: 'partial';
        safeAdvanceCursor: string | null;
        blockedCursor?: string | null;
        blockedReason?: string | null;
    };

export type ChangesCursorCheckpointContext = Readonly<{
    reason: 'changes-page' | 'snapshot-base';
    changes: readonly ChangeEntry[];
}>;

export type ChangesCursorBlockedContext = Readonly<{
    blockedCursor: string;
    blockedReason: string;
    safeAdvanceCursor: string | null;
    changes: readonly ChangeEntry[];
}>;

export type SnapshotBaseCursorFetchFailedContext = Readonly<{
    trigger: 'cursor-gone' | 'forced-snapshot' | 'page-budget';
    fallbackCursor: string;
    error: string;
}>;

export type ChangesCursorContractAnomalyContext = Readonly<{
    reason: 'returned-after-cursor' | 'returned-before-after-cursor' | 'duplicate-cursor-in-page';
    afterCursor: string;
    offendingCursor: string;
    nextCursor: string;
    changes: readonly ChangeEntry[];
}>;

export type UnsupportedChangesContext = readonly UnsupportedChangeMarker[];

function normalizeApplySafeCursor(result: PlannedChangesApplyResult, pageNextCursor: string): string | null {
    if (!result) return pageNextCursor;
    if (result.status === 'complete') return result.safeAdvanceCursor ?? pageNextCursor;
    return result.safeAdvanceCursor;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    return String(error);
}

function parseNumericCursor(cursor: string): number | null {
    if (!/^\d+$/.test(cursor)) return null;
    const parsed = Number(cursor);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function runSocketReconnectCatchUpViaChanges(params: {
    credentials: AuthCredentials | null;
    accountId: string | null;
    afterCursor: string | null;
    changesPageLimit: number;
    maxChangesPagesPerResume?: number;
    forceSnapshotRefresh: boolean;
    fetchChanges: FetchChangesFn;
    fetchCurrentCursor?: FetchCurrentChangesCursorFn;
    checkpointCursor?: (cursor: string, context: ChangesCursorCheckpointContext) => Promise<boolean> | boolean;
    onCursorBlocked?: (context: ChangesCursorBlockedContext) => void;
    onUnsupportedChanges?: (changes: UnsupportedChangesContext) => void;
    onSnapshotBaseCursorFetchFailed?: (context: SnapshotBaseCursorFetchFailedContext) => void;
    onCursorContractAnomaly?: (context: ChangesCursorContractAnomalyContext) => void;
    applyPlanned: (planned: PlannedChangeActions) => Promise<PlannedChangesApplyResult>;
    snapshotRefresh: () => Promise<SnapshotRefreshResult | void>;
}): Promise<
    | { status: 'fallback' }
    | { status: 'ok'; nextCursor: string; shouldPersistCursor: boolean }
> {
    if (!params.credentials) {
        return { status: 'fallback' };
    }

    if (!params.accountId) {
        return { status: 'fallback' };
    }

    const credentials = params.credentials;

    const checkpointApprovedCursor = async (
        cursor: string,
        context: ChangesCursorCheckpointContext,
    ): Promise<boolean> => {
        if (!params.checkpointCursor) return false;
        const checkpointed = await params.checkpointCursor(cursor, context);
        return checkpointed === true;
    };

    const reportBlockedCursor = (
        applyResult: PlannedChangesApplyResult,
        changes: readonly ChangeEntry[],
    ): void => {
        if (!params.onCursorBlocked || !applyResult || applyResult.status !== 'partial') return;
        const blockedCursor = applyResult.blockedCursor ?? null;
        if (!blockedCursor) return;
        if (
            applyResult.blockedReason === 'unsupported-kind'
            && applyResult.safeAdvanceCursor === blockedCursor
        ) {
            return;
        }
        params.onCursorBlocked({
            blockedCursor,
            blockedReason: applyResult.blockedReason ?? 'partial-materialization',
            safeAdvanceCursor: applyResult.safeAdvanceCursor,
            changes,
        });
    };

    const reportCursorContractAnomaly = (paramsForAnomaly: Readonly<{
        afterCursor: string;
        nextCursor: string;
        changes: readonly ChangeEntry[];
    }>): void => {
        if (!params.onCursorContractAnomaly) return;
        const seen = new Set<string>();
        const numericAfterCursor = parseNumericCursor(paramsForAnomaly.afterCursor);
        for (const change of paramsForAnomaly.changes) {
            const cursor = String(change.cursor);
            if (cursor === paramsForAnomaly.afterCursor) {
                params.onCursorContractAnomaly({
                    reason: 'returned-after-cursor',
                    afterCursor: paramsForAnomaly.afterCursor,
                    offendingCursor: cursor,
                    nextCursor: paramsForAnomaly.nextCursor,
                    changes: paramsForAnomaly.changes,
                });
                return;
            }
            const numericCursor = parseNumericCursor(cursor);
            // Diagnostic only: cursor advancement still treats cursors as opaque and derives order
            // from the server response. Non-numeric cursor formats skip this anomaly class.
            if (numericAfterCursor !== null && numericCursor !== null && numericCursor < numericAfterCursor) {
                params.onCursorContractAnomaly({
                    reason: 'returned-before-after-cursor',
                    afterCursor: paramsForAnomaly.afterCursor,
                    offendingCursor: cursor,
                    nextCursor: paramsForAnomaly.nextCursor,
                    changes: paramsForAnomaly.changes,
                });
                return;
            }
            if (seen.has(cursor)) {
                params.onCursorContractAnomaly({
                    reason: 'duplicate-cursor-in-page',
                    afterCursor: paramsForAnomaly.afterCursor,
                    offendingCursor: cursor,
                    nextCursor: paramsForAnomaly.nextCursor,
                    changes: paramsForAnomaly.changes,
                });
                return;
            }
            seen.add(cursor);
        }
    };

    const runSnapshotRepair = async (
        fallbackCursor: string,
        trigger: SnapshotBaseCursorFetchFailedContext['trigger'],
    ): Promise<
        | { status: 'fallback' }
        | { status: 'ok'; cursor: string; checkpointPersisted: boolean }
    > => {
        let snapshotBaseCursor = fallbackCursor;
        if (params.fetchCurrentCursor) {
            let current: Awaited<ReturnType<FetchCurrentChangesCursorFn>>;
            try {
                current = await params.fetchCurrentCursor({ credentials });
            } catch (error) {
                params.onSnapshotBaseCursorFetchFailed?.({
                    trigger,
                    fallbackCursor,
                    error: errorMessage(error),
                });
                return { status: 'fallback' };
            }
            if (current.status !== 'ok') {
                params.onSnapshotBaseCursorFetchFailed?.({
                    trigger,
                    fallbackCursor,
                    error: `status:${current.status}`,
                });
                return { status: 'fallback' };
            }
            snapshotBaseCursor = current.cursor;
        }

        const snapshot = await params.snapshotRefresh();
        if (snapshot && snapshot.status !== 'complete') {
            return { status: 'fallback' };
        }
        if (params.checkpointCursor) {
            const checkpointed = await checkpointApprovedCursor(snapshotBaseCursor, {
                reason: 'snapshot-base',
                changes: [],
            });
            if (!checkpointed) {
                return { status: 'fallback' };
            }
            return { status: 'ok', cursor: snapshotBaseCursor, checkpointPersisted: true };
        }
        return { status: 'ok', cursor: snapshotBaseCursor, checkpointPersisted: false };
    };

    let afterCursor = params.afterCursor ?? '0';
    const maxPages = Math.max(1, Math.trunc(params.maxChangesPagesPerResume ?? 5));
    let forceSnapshotRefresh = params.forceSnapshotRefresh;
    let snapshotCursorAwaitingFinalPersist: string | null = null;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const result = await params.fetchChanges({
            credentials,
            afterCursor,
            limit: params.changesPageLimit,
        });

        if (result.status === 'cursor-gone') {
            const snapshot = await runSnapshotRepair(result.currentCursor, 'cursor-gone');
            if (snapshot.status === 'fallback') {
                return snapshot;
            }
            afterCursor = snapshot.cursor;
            forceSnapshotRefresh = false;
            snapshotCursorAwaitingFinalPersist = snapshot.checkpointPersisted ? null : snapshot.cursor;
            continue;
        }

        if (result.status !== 'ok') {
            return { status: 'fallback' };
        }

        const { changes, nextCursor } = result;
        reportCursorContractAnomaly({ afterCursor, nextCursor, changes });

        if (forceSnapshotRefresh) {
            const snapshot = await runSnapshotRepair(nextCursor, 'forced-snapshot');
            if (snapshot.status === 'fallback') {
                return snapshot;
            }
            afterCursor = snapshot.cursor;
            forceSnapshotRefresh = false;
            snapshotCursorAwaitingFinalPersist = snapshot.checkpointPersisted ? null : snapshot.cursor;
            continue;
        }

        if (changes.length === 0) {
            return {
                status: 'ok',
                nextCursor,
                shouldPersistCursor: snapshotCursorAwaitingFinalPersist !== null || nextCursor !== afterCursor,
            };
        }

        const planned = planSyncActionsFromChanges(changes);
        if (planned.unsupportedChanges.length > 0) {
            params.onUnsupportedChanges?.(planned.unsupportedChanges);
        }
        const applyResult = await params.applyPlanned(planned);
        const safeAdvanceCursor = normalizeApplySafeCursor(applyResult, nextCursor);

        if (safeAdvanceCursor !== nextCursor) {
            const checkpointPersisted = safeAdvanceCursor !== null && safeAdvanceCursor !== afterCursor
                ? await checkpointApprovedCursor(safeAdvanceCursor, {
                    reason: 'changes-page',
                    changes,
                })
                : false;
            reportBlockedCursor(applyResult, changes);
            return {
                status: 'ok',
                nextCursor: safeAdvanceCursor ?? afterCursor,
                shouldPersistCursor: safeAdvanceCursor !== null && safeAdvanceCursor !== afterCursor && !checkpointPersisted,
            };
        }

        if (changes.length < params.changesPageLimit) {
            const checkpointPersisted = nextCursor !== afterCursor
                ? await checkpointApprovedCursor(nextCursor, {
                    reason: 'changes-page',
                    changes,
                })
                : false;
            return {
                status: 'ok',
                nextCursor,
                shouldPersistCursor: nextCursor !== afterCursor && !checkpointPersisted,
            };
        }

        const checkpointPersisted = nextCursor !== afterCursor
            ? await checkpointApprovedCursor(nextCursor, {
                reason: 'changes-page',
                changes,
            })
            : false;
        if (nextCursor !== afterCursor && params.checkpointCursor && !checkpointPersisted) {
            return { status: 'fallback' };
        }
        afterCursor = nextCursor;
    }

    const snapshot = await runSnapshotRepair(afterCursor, 'page-budget');
    if (snapshot.status === 'fallback') {
        return snapshot;
    }
    return {
        status: 'ok',
        nextCursor: snapshot.cursor,
        shouldPersistCursor: !snapshot.checkpointPersisted,
    };
}
