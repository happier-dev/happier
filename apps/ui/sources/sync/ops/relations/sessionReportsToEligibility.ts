import { SessionReportsToOptionsV1Schema, type SessionReportsToOptionsV1 } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';

import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

export type SessionReportsToEligibilitySnapshot = SessionReportsToOptionsV1 & Readonly<{
    serverId: string;
    accountId: string;
    isCurrent: () => boolean;
    dispose: () => void;
    readCandidate: (sessionId: string) => SessionReportsToOptionsV1['candidates'][number] | undefined;
}>;

/** Index current evidence once; hover only reads the selected candidate, never scans the batch. */
export function createSessionReportsToEligibilitySnapshot(input: SessionReportsToOptionsV1 & Readonly<{
    serverId: string; accountId: string; isCurrent: () => boolean; dispose: () => void;
}>): SessionReportsToEligibilitySnapshot {
    const candidates = new Map(input.candidates.map((candidate) => [candidate.sessionId, candidate]));
    let disposed = false;
    return { ...input,
        readCandidate: (sessionId) => candidates.get(sessionId),
        isCurrent: () => !disposed && input.isCurrent(),
        dispose: () => { if (!disposed) { disposed = true; input.dispose(); } },
    };
}

/** One demand-driven batch per gesture/chooser; no pointer-frame reads or persisted verdict. */
export async function loadSessionReportsToEligibility(input: Readonly<{
    serverId: string;
    sessionId: string;
    candidateSessionIds: readonly string[];
    signal?: AbortSignal;
}>): Promise<SessionReportsToEligibilitySnapshot | null> {
    let capturedAccount: LazyActionAccountContext | null = null;
    try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = capturedAccount = await captureLazyActionAccountContext(input.serverId, input.signal);
        const candidateSessionIds = [...new Set(input.candidateSessionIds)];
        const response = await account.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/reports-to/options`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidateSessionIds }),
            ...(input.signal ? { signal: input.signal } : {}),
        }, { includeAuth: true });
        account.assertCurrent();
        if (!response.ok) { account.dispose(); return null; }
        const parsed = SessionReportsToOptionsV1Schema.safeParse(await response.json());
        account.assertCurrent();
        if (!parsed.success || parsed.data.sessionId !== input.sessionId
            || parsed.data.candidates.length !== candidateSessionIds.length
            || parsed.data.candidates.some((candidate, index) => candidate.sessionId !== candidateSessionIds[index])) {
            account.dispose();
            return null;
        }
        return createSessionReportsToEligibilitySnapshot({
            ...parsed.data, serverId: account.serverId, accountId: account.accountId,
            isCurrent: () => account.accountLifetime.isCurrent(), dispose: account.dispose,
        });
    } catch {
        capturedAccount?.dispose();
        return null;
    }
}
