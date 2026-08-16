import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';

import { createRetentionRuleRegistry } from './retentionRuleRegistry';

export type RetentionSweepResult = Readonly<{
    deleted: number;
    byRule: Readonly<Record<string, number>>;
    details: Readonly<Record<string, Readonly<{
        deleted: number;
        candidatesExamined: number;
        batches: number;
        stopReason: 'exhausted' | 'time_budget' | 'row_budget' | 'candidate_budget' | 'stalled';
    }>>>;
}>;

export async function runRetentionSweep(params: {
    policy: RetentionPolicy;
    now?: Date;
    readClockMs?: () => number;
}): Promise<RetentionSweepResult> {
    const now = params.now ?? new Date();
    const readClockMs = params.readClockMs ?? Date.now;
    const registry = createRetentionRuleRegistry();
    const byRule: Record<string, number> = {};
    const details: Record<string, {
        deleted: number;
        candidatesExamined: number;
        batches: number;
        stopReason: 'exhausted' | 'time_budget' | 'row_budget' | 'candidate_budget' | 'stalled';
    }> = {};
    let deleted = 0;

    const deadline = readClockMs() + (params.policy.sweepTimeBudgetMs ?? 10_000);
    const maxCandidates = params.policy.maxCandidatesPerRulePerRun ?? 10_000;
    const active = new Set(registry.map((rule) => rule.id));

    for (const rule of registry) {
        details[rule.id] = {
            deleted: 0,
            candidatesExamined: 0,
            batches: 0,
            stopReason: 'exhausted',
        };
        byRule[rule.id] = 0;
    }

    while (active.size > 0 && readClockMs() < deadline) {
        let roundMadeProgress = false;
        for (const rule of registry) {
            if (!active.has(rule.id)) continue;
            const detail = details[rule.id]!;
            const remainingDeletes = params.policy.maxDeletesPerRulePerRun - detail.deleted;
            const remainingCandidates = maxCandidates - detail.candidatesExamined;
            if (remainingDeletes <= 0) {
                detail.stopReason = 'row_budget';
                active.delete(rule.id);
                continue;
            }
            if (remainingCandidates <= 0) {
                detail.stopReason = 'candidate_budget';
                active.delete(rule.id);
                continue;
            }
            if (readClockMs() >= deadline) break;

            const batchLimit = Math.max(1, Math.min(params.policy.batchSize, remainingDeletes));
            const result = await rule.run({
                policy: params.policy,
                batchSize: batchLimit,
                dryRun: params.policy.dryRun,
                maxDeletesPerRulePerRun: batchLimit,
                // Candidate scanning is paged at the same bounded size as deletion. The
                // per-rule candidate budget applies across the whole sweep, not one turn.
                maxCandidatesPerRulePerRun: Math.min(params.policy.batchSize, remainingCandidates),
                shouldContinue: () => readClockMs() < deadline,
                now,
            });
            const candidatesExamined = result.candidatesExamined ?? result.deleted;
            detail.deleted += result.deleted;
            detail.candidatesExamined += candidatesExamined;
            detail.batches += 1;
            byRule[result.id] = detail.deleted;
            deleted += result.deleted;
            roundMadeProgress ||= result.deleted > 0 || candidatesExamined > 0;

            const hasMore = result.hasMore ?? result.deleted >= batchLimit;
            if (!hasMore) {
                detail.stopReason = 'exhausted';
                active.delete(rule.id);
            } else if (detail.deleted >= params.policy.maxDeletesPerRulePerRun) {
                detail.stopReason = 'row_budget';
                active.delete(rule.id);
            } else if (detail.candidatesExamined >= maxCandidates) {
                detail.stopReason = 'candidate_budget';
                active.delete(rule.id);
            }
        }
        if (!roundMadeProgress) {
            for (const id of active) details[id]!.stopReason = 'stalled';
            active.clear();
        }
    }

    if (active.size > 0) {
        for (const id of active) details[id]!.stopReason = 'time_budget';
    }

    return {
        deleted,
        byRule,
        details,
    };
}
