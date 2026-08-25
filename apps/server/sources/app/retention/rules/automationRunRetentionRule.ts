import type { Prisma } from '@prisma/client';

import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import {
    automationRunCustodyTerminalWhere,
    finalizeDeletedAutomationsWithoutRetainedRunsTx,
} from '@/app/automations/automationCrudService';
import { emitAutomationRunUpdated } from '@/app/automations/automationChangePublisher';
import { automationRunItemSelect } from '@/app/automations/automationPersistenceSelect';
import type { AutomationRunItem } from '@/app/automations/automationTypes';
import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { db } from '@/storage/db';
import { afterTx, inTx } from '@/storage/inTx';

const ACCOUNT_DEFAULT_AUTOMATION_RUN_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const automationRunRetentionCandidateSelect = {
    ...automationRunItemSelect,
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

function isAutomationRunOldEnoughToDelete(
    run: AutomationRunRetentionCandidate,
    policy: RetentionPolicy,
    now: Date,
): boolean {
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

/**
 * Compaction deliberately leaves Event/Conversation rejoin evidence intact:
 * same occurrence keys can still distinguish different signed evidence after
 * mutable execution and reply content has been removed. Schedule/Manual Runs
 * have no such evidence contract, so a corrupt retained value is also cleared.
 */
function automationRunContentCompactionWhere(): Prisma.AutomationRunWhereInput {
    return {
        contentRemovedAt: null,
        OR: [
            { executionInputEnvelope: { not: null } },
            { resultEnvelope: { not: null } },
            { replyContextEnvelope: { not: null } },
            { replyHandoffReceiptEnvelope: { not: null } },
            { summaryCiphertext: { not: null } },
            { errorMessage: { not: null } },
            {
                originKind: { in: ['scheduled', 'manual'] },
                triggerEvidenceEnvelope: { not: null },
            },
            {
                originKind: { in: ['scheduled', 'manual'] },
                occurrenceEvidenceEqualityTag: { not: null },
            },
        ],
    };
}

function hasAutomationRunContentToCompact(run: AutomationRunRetentionCandidate): boolean {
    if (run.contentRemovedAt !== null) return false;
    if (
        run.executionInputEnvelope !== null
        || run.resultEnvelope !== null
        || run.replyContextEnvelope !== null
        || run.replyHandoffReceiptEnvelope !== null
        || run.summaryCiphertext !== null
        || run.errorMessage !== null
    ) {
        return true;
    }
    return (run.originKind === 'scheduled' || run.originKind === 'manual')
        && (
            run.triggerEvidenceEnvelope !== null
            || run.occurrenceEvidenceEqualityTag !== null
        );
}

async function compactAutomationRunContent(
    run: AutomationRunRetentionCandidate,
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
        if (!current || !hasAutomationRunContentToCompact(current)) return false;
        const removeOriginEvidence = current.originKind === 'scheduled'
            || current.originKind === 'manual';
        const updated = await tx.automationRun.updateMany({
            where: {
                id: current.id,
                accountId: current.accountId,
                revision: current.revision,
                contentRemovedAt: null,
                ...automationRunCustodyTerminalWhere(),
            },
            data: {
                ...(removeOriginEvidence
                    ? {
                        triggerEvidenceEnvelope: null,
                        occurrenceEvidenceEqualityTag: null,
                    }
                    : {}),
                executionInputEnvelope: null,
                resultEnvelope: null,
                replyContextEnvelope: null,
                replyHandoffReceiptEnvelope: null,
                summaryCiphertext: null,
                errorMessage: null,
                contentRemovedAt: now,
                revision: { increment: 1 },
                updatedAt: now,
            },
        });
        if (updated.count !== 1) return false;
        const compacted = await tx.automationRun.findFirst({
            where: { id: current.id, accountId: current.accountId },
            select: automationRunItemSelect,
        });
        if (!compacted) return false;
        const cursor = await markAccountChanged(tx, {
            accountId: current.accountId,
            kind: 'automation',
            entityId: current.automationId,
        });
        afterTx(tx, () => {
            emitAutomationRunUpdated({
                accountId: current.accountId,
                run: compacted as AutomationRunItem,
                cursor,
            });
        });
        return true;
    });
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
        if (!current || !isAutomationRunOldEnoughToDelete(current, policy, now)) {
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
        await markAccountChanged(tx, {
            accountId: current.accountId,
            kind: 'automation',
            entityId: current.automationId,
        });
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
    return {
        id: 'automationRuns',
        run: async (params) => {
            const limit = Math.max(1, Math.min(
                params.batchSize,
                params.maxDeletesPerRulePerRun,
                params.maxCandidatesPerRulePerRun ?? Number.MAX_SAFE_INTEGER,
            ));
            const candidatesWithLookahead = await db.automationRun.findMany({
                where: {
                    ...automationRunCustodyTerminalWhere(),
                    OR: [
                        ...automationRunAgeRetentionWhere(params.policy, params.now),
                        automationRunContentCompactionWhere(),
                    ],
                },
                select: automationRunRetentionCandidateSelect,
                orderBy: { id: 'asc' },
                take: limit + 1,
                ...(params.dryRun && dryRunOffset > 0 ? { skip: dryRunOffset } : {}),
            });
            const candidates = candidatesWithLookahead.slice(0, limit);
            if (params.dryRun) dryRunOffset += candidates.length;

            let deleted = 0;
            for (const candidate of candidates) {
                if (params.shouldContinue && !params.shouldContinue()) break;
                if (isAutomationRunOldEnoughToDelete(candidate, params.policy, params.now)) {
                    if (params.dryRun) {
                        deleted += 1;
                    } else if (await deleteAutomationRunHistory(candidate, params.policy, params.now)) {
                        deleted += 1;
                    }
                    continue;
                }
                if (!params.dryRun && hasAutomationRunContentToCompact(candidate)) {
                    await compactAutomationRunContent(candidate, params.now);
                }
            }

            // Deleting the last retained Run is what makes a soft-deleted
            // Automation removable. The parent has no age rule of its own:
            // it is already unreachable, and its Runs were the only thing
            // that kept the row alive.
            if (!params.dryRun) {
                await finalizeDeletedAutomationDefinitions(limit);
            }

            return {
                id: 'automationRuns',
                deleted,
                candidatesExamined: candidates.length,
                hasMore: candidatesWithLookahead.length > limit,
            };
        },
    };
}
