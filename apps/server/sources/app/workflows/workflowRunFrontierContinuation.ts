import { readWorkflowInvocationMembersV1 } from '@happier-dev/protocol/workflows/workflowInvocationMembersV1';
import type { Tx } from '@/storage/inTx';

/** The existing boundary Continue can advance a settled frontier without retrying it. */
export async function readWorkflowRunFrontierContinuationsInTx(tx: Tx, runs: readonly Readonly<{
    id: string; state: string; workflowCustodyState: string | null;
}>[]): Promise<ReadonlySet<string>> {
    const runIds = runs.filter(run => run.state === 'interrupted' && run.workflowCustodyState === 'pending').map(run => run.id);
    if (runIds.length === 0) return new Set();
    // Eligibility needs only admitted indexes, including E2EE Runs. Read the
    // candidate set together; ordinary Run projections never visit history.
    const rows = await tx.workflowRunInvocation.findMany({
        where: { runId: { in: runIds } }, orderBy: { sequence: 'asc' },
        select: { id: true, runId: true, sequence: true, parentRecordId: true, memberOrdinal: true,
            attempt: true, lifecycle: true },
    });
    type Row = typeof rows[number];
    const byRun = new Map<string, Row[]>();
    for (const row of rows) {
        const group = byRun.get(row.runId) ?? [];
        group.push(row);
        byRun.set(row.runId, group);
    }
    const eligible = new Set<string>();
    for (const [runId, invocations] of byRun) {
        const byParent = new Map<string | null, Row[]>();
        const slots = new Map<string | null, Map<string, Map<bigint, Row>>>();
        const previous = new Map<string, string | undefined>();
        for (const row of invocations) {
            // Admission/recovery write attempt+1 in the same ordinal, optionally
            // rebinding its parent to that parent's replacement. Sequence order
            // puts those parent replacements before their child replacements.
            let parentId = row.parentRecordId;
            let prior: Row | undefined;
            if (row.attempt > 0n) {
                for (;;) {
                    prior = slots.get(parentId)?.get(row.memberOrdinal.toString())?.get(row.attempt - 1n);
                    if (prior || parentId === null) break;
                    const olderParent = previous.get(parentId);
                    if (!olderParent) break;
                    parentId = olderParent;
                }
            }
            previous.set(row.id, prior?.id);
            const parentSlots = slots.get(row.parentRecordId) ?? new Map<string, Map<bigint, Row>>();
            const attempts = parentSlots.get(row.memberOrdinal.toString()) ?? new Map<bigint, Row>();
            attempts.set(row.attempt, row);
            parentSlots.set(row.memberOrdinal.toString(), attempts);
            slots.set(row.parentRecordId, parentSlots);
            const children = byParent.get(row.parentRecordId) ?? [];
            children.push(row);
            byParent.set(row.parentRecordId, children);
        }
        const root = byParent.get(null)?.reduce((latest, row) => row.attempt > latest.attempt ? row : latest);
        if (!root || root.lifecycle !== 'running') continue;
        const indexOf = (row: Row) => ({ id: row.id, parentRecordId: row.parentRecordId,
            memberOrdinal: row.memberOrdinal.toString(), attempt: row.attempt.toString() });
        let frontier = [root];
        let completedMember = false;
        let settled = true;
        while (frontier.length && settled) {
            const members = await readWorkflowInvocationMembersV1({ parentRecordIds: frontier.filter(row => row.lifecycle === 'running').map(row => row.id), indexOf,
                readChildren: async ids => ids.flatMap(id => byParent.get(id) ?? []),
                readPreviousParents: async ids => new Map(ids.map(id => [id, previous.get(id)])) });
            const next: Row[] = [];
            for (const row of frontier) {
                // A completed/skipped frame already owns the outcome of its
                // descendants (including cancelled first-success losers).
                if (row.lifecycle === 'completed') { completedMember = true; continue; }
                if (row.lifecycle === 'skipped') continue;
                const children = members.get(row.id) ?? [];
                if (row.lifecycle !== 'running' || children.length === 0) {
                    settled = false;
                    break;
                }
                next.push(...children);
            }
            frontier = next;
        }
        if (settled && completedMember) eligible.add(runId);
    }
    return eligible;
}
