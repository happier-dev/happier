import type { Prisma } from '@prisma/client';

import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import {
    automationRunCustodyTerminalWhere,
    finalizeDeletedAutomationsWithoutRetainedRunsTx,
} from '@/app/automations/automationCrudService';
import { emitAutomationUpsert } from '@/app/automations/automationChangePublisher';
import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { db } from '@/storage/db';
import { afterTx, inTx } from '@/storage/inTx';

const ACCOUNT_DEFAULT_AUTOMATION_RUN_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const automationRunRetentionCandidateSelect = {
    // Retention needs only its deletion fence and the parent/account policy
    // facts. Private execution, trigger, result, and reply envelopes remain
    // with the Run detail/custody owners and are never materialized by a sweep.
    id: true,
    accountId: true,
    automationId: true,
    finishedAt: true,
    revision: true,
    automation: {
        select: {
            id: true,
            templateVersion: true,
            enabled: true,
            deletedAt: true,
            updatedAt: true,
        },
    },
    account: {
        select: {
            automationRunRetention: true,
        },
    },
} satisfies Prisma.AutomationRunSelect;

type AutomationRunRetentionCandidate = Prisma.AutomationRunGetPayload<{
    select: typeof automationRunRetentionCandidateSelect;
}>;

function readOperatorAutomationRunRetentionDays(policy: RetentionPolicy): number | null {
    const domain = policy.domains.automationRuns;
    return policy.enabled && domain.mode === 'delete_older_than'
        ? domain.days
        : null;
}

function ageCutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS);
}

function automationRunAgeRetentionWhere(
    policy: RetentionPolicy,
    now: Date,
): readonly Prisma.AutomationRunWhereInput[] {
    const operatorDays = readOperatorAutomationRunRetentionDays(policy);
    const defaultDays = operatorDays === null
        ? ACCOUNT_DEFAULT_AUTOMATION_RUN_RETENTION_DAYS
        : Math.min(ACCOUNT_DEFAULT_AUTOMATION_RUN_RETENTION_DAYS, operatorDays);
    const ageWhere: Prisma.AutomationRunWhereInput[] = [{
        account: { automationRunRetention: 'thirtyDays' },
        finishedAt: { lt: ageCutoff(now, defaultDays) },
    }];
    if (operatorDays !== null) {
        ageWhere.push({
            account: { automationRunRetention: 'keepForever' },
            finishedAt: { lt: ageCutoff(now, operatorDays) },
        });
    }
    return ageWhere;
}

function isAutomationRunEligibleForDeletion(
    run: AutomationRunRetentionCandidate,
    policy: RetentionPolicy,
    now: Date,
): boolean {
    // Deleting an Automation is an explicit request to clear its retained Run
    // history. Custody safety remains owned by automationRunCustodyTerminalWhere;
    // once a Run is terminal, Account keep-forever history must not strand the
    // soft-deleted parent indefinitely.
    if (run.automation.deletedAt !== null) return true;
    if (run.finishedAt === null) return false;
    const operatorDays = readOperatorAutomationRunRetentionDays(policy);
    const retentionDays = run.account.automationRunRetention === 'thirtyDays'
        ? (operatorDays === null
            ? ACCOUNT_DEFAULT_AUTOMATION_RUN_RETENTION_DAYS
            : Math.min(ACCOUNT_DEFAULT_AUTOMATION_RUN_RETENTION_DAYS, operatorDays))
        : run.account.automationRunRetention === 'keepForever'
            ? operatorDays
            : null;
    return retentionDays !== null
        && run.finishedAt.getTime() < ageCutoff(now, retentionDays).getTime();
}

async function deleteAutomationRunHistory(
    run: AutomationRunRetentionCandidate,
    policy: RetentionPolicy,
    now: Date,
): Promise<boolean> {
    return await inTx(async (tx) => {
        const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            run.accountId,
        );
        if (accountFence.status !== 'ready') return false;
        const current = await tx.automationRun.findFirst({
            where: { id: run.id, accountId: run.accountId },
            select: automationRunRetentionCandidateSelect,
        });
        if (!current || !isAutomationRunEligibleForDeletion(current, policy, now)) {
            return false;
        }
        const deleted = await tx.automationRun.deleteMany({
            where: {
                id: current.id,
                accountId: current.accountId,
                revision: current.revision,
                ...automationRunCustodyTerminalWhere(),
            },
        });
        if (deleted.count !== 1) return false;
        const cursor = await markAccountChanged(tx, {
            accountId: current.accountId,
            kind: 'automation',
            entityId: current.automationId,
        });
        afterTx(tx, () => emitAutomationUpsert({
            accountId: current.accountId,
            automation: current.automation,
            cursor,
        }));
        return true;
    });
}

async function finalizeDeletedAutomationDefinitions(limit: number): Promise<void> {
    const candidates = await db.automation.findMany({
        where: {
            deletedAt: { not: null },
            runs: { none: {} },
        },
        orderBy: { deletedAt: 'asc' },
        take: limit,
        select: { accountId: true },
    });
    const limitsByAccount = new Map<string, number>();
    for (const candidate of candidates) {
        limitsByAccount.set(
            candidate.accountId,
            (limitsByAccount.get(candidate.accountId) ?? 0) + 1,
        );
    }
    for (const [accountId, accountLimit] of limitsByAccount) {
        // Each transaction owns exactly one Account-first transition fence.
        // Keeping the batch account-scoped avoids a cross-Account lock order.
        await inTx(async (tx) => {
            await finalizeDeletedAutomationsWithoutRetainedRunsTx({
                tx,
                accountId,
                limit: accountLimit,
            });
        });
    }
}

export function createAutomationRunRetentionRule(): RetentionRule {
    let dryRunOffset = 0;
    let dryRunReceiptOffset = 0;
    return {
        id: 'automationRuns',
        run: async (params) => {
            const limit = Math.max(1, Math.min(
                params.batchSize,
                params.maxDeletesPerRulePerRun,
                params.maxCandidatesPerRulePerRun ?? Number.MAX_SAFE_INTEGER,
            ));
            const receiptCandidatesWithLookahead = await db.automationWorkerClaimReceipt.findMany({
                where: { expiresAt: { lt: params.now } },
                orderBy: { id: 'asc' },
                take: limit + 1,
                ...(params.dryRun && dryRunReceiptOffset > 0
                    ? { skip: dryRunReceiptOffset }
                    : {}),
                select: { id: true },
            });
            const receiptCandidates = receiptCandidatesWithLookahead.slice(0, limit);
            if (params.dryRun) dryRunReceiptOffset += receiptCandidates.length;
            const receiptDeleted = params.dryRun
                ? receiptCandidates.length
                : (await db.automationWorkerClaimReceipt.deleteMany({
                    where: { id: { in: receiptCandidates.map((receipt) => receipt.id) } },
                })).count;
            const runLimit = Math.max(0, limit - receiptDeleted);
            const candidatesWithLookahead = await db.automationRun.findMany({
                where: {
                    ...automationRunCustodyTerminalWhere(),
                    OR: [
                        ...automationRunAgeRetentionWhere(params.policy, params.now),
                        { automation: { deletedAt: { not: null } } },
                    ],
                },
                select: automationRunRetentionCandidateSelect,
                orderBy: { id: 'asc' },
                take: runLimit + 1,
                ...(params.dryRun && dryRunOffset > 0 ? { skip: dryRunOffset } : {}),
            });
            const candidates = candidatesWithLookahead.slice(0, runLimit);
            if (params.dryRun) dryRunOffset += candidates.length;

            let deleted = receiptDeleted;
            for (const candidate of candidates) {
                if (params.shouldContinue && !params.shouldContinue()) break;
                if (isAutomationRunEligibleForDeletion(candidate, params.policy, params.now)) {
                    if (params.dryRun) {
                        deleted += 1;
                    } else if (await deleteAutomationRunHistory(candidate, params.policy, params.now)) {
                        deleted += 1;
                    }
                }
            }

            // Deleting the last retained Run is what makes a soft-deleted
            // Automation removable. The parent has no age rule of its own:
            // it is already unreachable, and its Runs were the only thing
            // that kept the row alive.
            if (!params.dryRun && runLimit > 0) {
                await finalizeDeletedAutomationDefinitions(runLimit);
            }

            return {
                id: 'automationRuns',
                deleted,
                candidatesExamined: receiptCandidates.length + candidates.length,
                hasMore: receiptCandidatesWithLookahead.length > limit
                    || candidatesWithLookahead.length > runLimit,
            };
        },
    };
}
