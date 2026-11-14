/** @moduleRealm daemon */

/**
 * A row's place in Browse's newest-activity-first order: its cheap activity
 * fact (a file mtime or the provider's own recency column) and its remote
 * session id as the code-unit tie-break. A continuation names the last row a
 * page consumed by these values, so a later page resumes strictly after it
 * however the rows above it moved in the meantime.
 */
export type ExternalSessionActivityPosition = Readonly<{
    updatedAtMs: number;
    remoteSessionId: string;
}>;

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Newest activity first, then remote session id by UTF-16 code unit. */
export function compareExternalSessionActivityPositions(
    left: ExternalSessionActivityPosition,
    right: ExternalSessionActivityPosition,
): number {
    return right.updatedAtMs - left.updatedAtMs
        || compareCodeUnits(left.remoteSessionId, right.remoteSessionId);
}

export function parseExternalSessionActivityPosition(value: unknown): ExternalSessionActivityPosition | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const updatedAtMs = Reflect.get(value, 'updatedAtMs');
    const remoteSessionId = Reflect.get(value, 'remoteSessionId');
    if (!Number.isSafeInteger(updatedAtMs) || typeof remoteSessionId !== 'string' || remoteSessionId.length === 0) {
        return null;
    }
    return Object.freeze({ updatedAtMs: updatedAtMs as number, remoteSessionId });
}

export class ExternalSessionActivityPageBudgetError extends Error {
    readonly name = 'ExternalSessionActivityPageBudgetError';
}

/**
 * One Browse page in activity order from a source's cheap per-row facts.
 *
 * The caller lists every row's activity position (one stat pass, or the
 * provider's own ordering column) and supplies `readRows` for the expensive
 * part — titles, cwd, top-level/thread classification. Rows are read only
 * from the continuation onward and only as many as the page still needs, so
 * page 1 of a 50k-session corpus reads about one page of heads. `readRows`
 * returns `null` for a row this listing excludes (an internal thread in a
 * top-level listing); the page then reads just enough further rows to fill.
 *
 * `fits` is the caller's real serialized-result predicate. A row that does not
 * fit ends the page before it, and the continuation resumes at that row.
 */
export async function pageExternalSessionCandidatesByActivity<
    TEntry extends ExternalSessionActivityPosition,
    TCandidate,
>(params: Readonly<{
    entries: readonly TEntry[];
    after?: ExternalSessionActivityPosition | null;
    limit: number;
    readRows(entries: readonly TEntry[]): Promise<readonly (TCandidate | null)[]>;
    /**
     * `next` is the continuation the page would carry if it ended after the
     * last candidate (`null` when that row is the last one), so the caller can
     * measure its real cursor rather than a worst case.
     */
    fits?(candidates: readonly TCandidate[], next: ExternalSessionActivityPosition | null): boolean;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    candidates: TCandidate[];
    next: ExternalSessionActivityPosition | null;
    /** Rows handed to `readRows`, for callers and tests that count head reads. */
    rowsRead: number;
}>> {
    const limit = Math.max(1, Math.trunc(params.limit));
    const sorted = [...params.entries].sort(compareExternalSessionActivityPositions);
    const after = params.after ?? null;
    let low = 0;
    let high = sorted.length;
    if (after) {
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (compareExternalSessionActivityPositions(sorted[middle]!, after) <= 0) low = middle + 1;
            else high = middle;
        }
    }
    const candidates: TCandidate[] = [];
    let consumed = after ? low : 0;
    let rowsRead = 0;
    let budgetStopped = false;
    while (!budgetStopped && candidates.length < limit && consumed < sorted.length) {
        params.signal?.throwIfAborted();
        const batch = sorted.slice(consumed, consumed + (limit - candidates.length));
        const rows = await params.readRows(batch);
        params.signal?.throwIfAborted();
        if (rows.length !== batch.length) {
            throw new Error('External-session activity page reader must return one result per row');
        }
        rowsRead += batch.length;
        for (const row of rows) {
            if (row !== null) {
                const rowEntry = sorted[consumed]!;
                const nextIfLast = consumed + 1 < sorted.length
                    ? Object.freeze({ updatedAtMs: rowEntry.updatedAtMs, remoteSessionId: rowEntry.remoteSessionId })
                    : null;
                if (params.fits && !params.fits([...candidates, row], nextIfLast)) {
                    if (candidates.length === 0) {
                        throw new ExternalSessionActivityPageBudgetError(
                            'External-session candidate result byte budget cannot fit one candidate.',
                        );
                    }
                    budgetStopped = true;
                    break;
                }
                candidates.push(row);
            }
            consumed += 1;
        }
    }
    const last = consumed > 0 ? sorted[consumed - 1] : undefined;
    return {
        candidates,
        next: consumed < sorted.length && last
            ? Object.freeze({ updatedAtMs: last.updatedAtMs, remoteSessionId: last.remoteSessionId })
            : null,
        rowsRead,
    };
}
