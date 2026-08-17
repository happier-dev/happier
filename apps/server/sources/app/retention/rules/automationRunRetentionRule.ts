import {
    AUTOMATION_RUN_REPLY_HANDOFF_TERMINAL_STATES,
    AUTOMATION_RUN_TERMINAL_STATES,
} from '@/app/automations/automationTypes';

import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createAutomationRunRetentionRule() {
    return createDeleteManyRetentionRule({
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
}
