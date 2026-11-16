import { WorkflowDraftEditInputV1Schema, WorkflowDraftMutationResultV1Schema,
    type WorkflowDraftMutationResultV1, type WorkflowMountedDraftV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';

import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { callWorkflowAction, type WorkflowActionCallerContext } from '@/sync/domains/workflows/callWorkflowAction';

/** Apply the selected event and Only-when together, preserving the addressed draft's rows and context. */
export async function addWorkflowEventToMountedDraft(params: Readonly<{
    draft: WorkflowMountedDraftV1;
    trigger: AutomationTriggerDefinitionInput;
    payloadSchema?: PluginJsonSchemaV2 | null;
    clientId?: string;
    signal?: AbortSignal;
    context?: WorkflowActionCallerContext;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): Promise<WorkflowDraftMutationResultV1> {
    const { draft } = params;
    const input = WorkflowDraftEditInputV1Schema.parse({ scope: draft.scope, draftId: draft.draftId,
        expectedDraftRevision: draft.draftRevision,
        settings: { triggers: { ...draft.settings.triggers, rows: [...draft.settings.triggers.rows, {
            identity: { clientId: params.clientId ?? randomUUID() }, trigger: params.trigger, enabled: params.trigger.enabled,
            ...(params.payloadSchema === undefined ? {} : { payloadSchema: params.payloadSchema }),
        }] } },
    });
    return callWorkflowAction({ actionId: 'workflow.authoring.draft.edit', input,
        parseResult: value => WorkflowDraftMutationResultV1Schema.parse(value),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        ...(params.context === undefined ? {} : { context: params.context }),
        ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
    });
}
