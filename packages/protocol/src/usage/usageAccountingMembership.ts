import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';

export const UsageAccountingSessionMembershipSchema = lazyZodSchema(() => z.strictObject({
    turns: z.array(z.strictObject({ sessionId: z.string().check(z.minLength(1)), turnId: z.string().check(z.minLength(1)),
        executions: z.array(z.enum(['happier', 'outside', 'unknown'])).check(z.minLength(1)) })),
}));
export type UsageAccountingSessionMembership = z.infer<typeof UsageAccountingSessionMembershipSchema>;

/** Public accounting carries the same admission even when ordinary Session detail is not requested. */
export function readUsageAccountingSessionMembership(accounting: UsageAnalyticsQueryResponse | undefined): Readonly<{
    sessionIds?: readonly string[];
    turns?: UsageAccountingSessionMembership['turns'];
}> | undefined {
    const membership = accounting?.sessionMembership ?? accounting?.summary?.publicProfileAccounting?.membership;
    // Legacy accounting can admit a Session without admitting any turn.
    return accounting?.sessionIds === undefined ? membership : { ...membership, sessionIds: accounting.sessionIds };
}

/** Accounting admits historical turns once, independently of how its event rows are delivered. */
export function projectUsageAccountingSessionMembership(contributions: readonly UsageAnalyticsContribution[]): UsageAccountingSessionMembership {
    return mergeUsageAccountingSessionMembership(contributions.flatMap(row => row.sessionId === null || row.turnId === null ? []
        : [{ turns: [{ sessionId: row.sessionId, turnId: row.turnId, executions: [row.sourceContext?.execution ?? 'unknown'] }] }]));
}

export function projectUsageAccountingSessionIds(contributions: readonly Pick<UsageAnalyticsContribution, 'sessionId'>[]): string[] {
    return [...new Set(contributions.flatMap(row => row.sessionId === null ? [] : [row.sessionId]))];
}

/** Preserve the first canonical occurrence of each turn and execution across dated partitions. */
export function mergeUsageAccountingSessionMembership(parts: readonly UsageAccountingSessionMembership[]): UsageAccountingSessionMembership {
    const turns = new Map<string, UsageAccountingSessionMembership['turns'][number]>();
    for (const part of parts) for (const row of part.turns) {
        const key = JSON.stringify([row.sessionId, row.turnId]);
        const turn = turns.get(key) ?? { sessionId: row.sessionId, turnId: row.turnId, executions: [] };
        for (const execution of row.executions) if (!turn.executions.includes(execution)) turn.executions.push(execution);
        turns.set(key, turn);
    }
    return { turns: [...turns.values()] };
}
