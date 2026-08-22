import { finalizeDeletedAutomationsWithoutRetainedRunsTx } from '@/app/automations/automationCrudService';
import {
    AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES,
    AUTOMATION_RUN_TERMINAL_STATES,
} from '@/app/automations/automationTypes';
import type { RetentionRule } from '@/app/retention/runtime/retentionRuleRegistry';
import { inTx } from '@/storage/inTx';

import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createAutomationRunRetentionRule(): RetentionRule {
    const retainedRuns = createDeleteManyRetentionRule({
        id: 'automationRuns',
        modelName: 'automationRun',
        primaryField: 'id',
        cutoffField: 'finishedAt',
        extraWhere: () => ({
            state: { in: AUTOMATION_RUN_TERMINAL_STATES },
            // A succeeded Conversation Run is the only terminal Run whose
            // reply lifecycle may still require custody. Preserve it until
            // the handoff has a terminal disposition.
            OR: [
                { state: { not: 'succeeded' } },
                { originKind: { not: 'conversation' } },
                { replyHandoffState: { in: AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES } },
            ],
        }),
    });
    return {
        id: retainedRuns.id,
        run: async (params) => {
            const result = await retainedRuns.run(params);
            // Deleting the last retained Run is what makes a soft-deleted
            // Automation removable, so the same sweep finishes that deletion.
            // The parent has no age rule of its own: it is already unreachable,
            // and its Runs are the only thing that kept the row alive.
            if (!params.dryRun) {
                await inTx(async (tx) => {
                    await finalizeDeletedAutomationsWithoutRetainedRunsTx({
                        tx,
                        limit: Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun)),
                    });
                });
            }
            return result;
        },
    };
}
