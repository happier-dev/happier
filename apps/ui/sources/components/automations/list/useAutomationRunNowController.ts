import React from 'react';

import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    useTransientCommandAcknowledgement,
    type TransientCommandState,
} from '@/hooks/ui/useTransientCommandAcknowledgement';
import { formatAutomationErrorMessage } from '@/components/automations/automationErrorFormatting';
import type {
    AutomationDefinition,
    AutomationRunNowAdmission,
} from '@/sync/domains/automations/automationTypes';

export type AutomationRunNowState = TransientCommandState;

/**
 * Sole UI owner of Run Now invocation and pending acknowledgement.
 *
 * The press-level state machine — in-flight guarding, the acknowledgement
 * window and its Account/server-scoped keys — is the shared transient-command
 * owner, so list/detail navigation and virtualized row recycling cannot create
 * competing guards and the Workflow Run now press cannot drift from this one.
 * What stays here is the Automation effect and its own failure copy.
 */
export type AutomationRunNowController = Readonly<{
    stateFor: (automationId: string) => AutomationRunNowState;
    /**
     * Returns the exact admission receipt the server accepted. `null` means
     * this invocation did not produce a current handle (unscoped, duplicate,
     * failed, or retired Account lifetime).
     *
     * Managed-workflow navigation reads `workflowRun` from that receipt, which
     * the Protocol schema already binds to the returned Run id. Consumers must
     * not infer a managed Workflow Run from the legacy Run projection or pick
     * the newest history row.
     */
    runNow: (
        automationId: string,
        targetType: AutomationDefinition['targetType'],
        options?: Readonly<{
            isInvocationCurrent?: () => boolean;
        }>,
    ) => Promise<AutomationRunNowAdmission | null>;
}>;

export function useAutomationRunNowController(): AutomationRunNowController {
    const command = useTransientCommandAcknowledgement<AutomationRunNowAdmission>('automation.runNow');

    return React.useMemo(() => ({
        stateFor: command.stateFor,
        runNow: async (automationId, _targetType, options) => await command.run({
            commandId: automationId,
            submit: () => callWorkflowAction({ actionId: 'workflow.trigger.run_now', input: { automationId },
                parseResult: (value) => WorkflowActionOutputSchemasV1['workflow.trigger.run_now'].parse(value) }),
            ...(options?.isInvocationCurrent
                ? { isInvocationCurrent: options.isInvocationCurrent }
                : {}),
            onError: async (error) => {
                await Modal.alert(
                    t('common.error'),
                    formatAutomationErrorMessage(error, t('automations.detail.runFailed')),
                );
            },
        }),
    }), [command]);
}
