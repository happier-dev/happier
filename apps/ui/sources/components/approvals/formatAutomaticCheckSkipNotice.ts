import type { readActionAutomationSkipReasonV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { t } from '@/text';

/** Approval cards and completed UI Actions use the same explanation for a skipped check. */
export function formatAutomaticCheckSkipNotice(input: Readonly<{
    reason: ReturnType<typeof readActionAutomationSkipReasonV1>;
    workflow: string;
    executionAccountName?: string;
}>): string {
    if (input.reason === 'machineRequired') {
        return t('workflows.triggers.checks.skippedNeedsMachine', { workflow: input.workflow });
    }
    if (input.reason === 'actorConsentUnavailableForRequester' && input.executionAccountName) {
        return t('workflows.triggers.checks.skippedNotAllowedBy', { workflow: input.workflow, name: input.executionAccountName });
    }
    return t('workflows.triggers.checks.skippedUnavailable', { workflow: input.workflow });
}
