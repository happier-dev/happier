import type { WorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { readDeviceTimeZone } from '@/components/workflows/triggers/sessionTriggerForm';

/** Ordinary Workflow + scheduled Automation seed; Save remains the editor's only write. */
export const WEEKLY_STORAGE_REVIEW_PROMPT = [
    'Review storage on my machines. Read each machine’s storage summary and suggestions.',
    'For each machine with something worth cleaning, propose one cleanup through Move items to Trash (machines.storage.trash.move), with the reasons and expected space for each item.',
    'For the others, say “Nothing worth cleaning on <machine>” in one line.',
    'Name what grew since the last scan when that fact is available; do not invent a comparison when it is not.',
    'Never permanently delete or empty Trash in this review.',
    'Finish with a short per-machine summary.',
].join(' ');

export function createWeeklyStorageReviewWorkflowSeed(input: Readonly<{ name: string }>): WorkflowDefinitionDraftSeed & { definition: WorkflowDefinitionV1 } {
    return {
        name: input.name,
        definition: {
            version: 1,
            inputs: [],
            defaults: {},
            blocks: [{
                kind: 'step', id: 'review-storage', name: input.name,
                document: { text: WEEKLY_STORAGE_REVIEW_PROMPT, references: [], attachments: [] },
                input: [], result: { kind: 'text' },
            }],
            finalOutput: { kind: 'result', producer: { blockId: 'review-storage', scope: { kind: 'current' } }, path: [] },
        },
        trigger: { kind: 'schedule', enabled: true,
            schedule: { kind: 'cron', scheduleExpr: '0 9 * * 1', everyMs: null, timezone: readDeviceTimeZone() } },
    };
}
