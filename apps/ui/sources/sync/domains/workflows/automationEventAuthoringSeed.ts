import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { AutomationRunLifecycleSource } from '@happier-dev/protocol/automations/automationRunLifecycle';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';

const KIND = 'automation-event-authoring';

/** Host-authored Run intent uses the same Account-bound draft intake as plugin Event intent. */
export type ManagedRunLifecycleAuthoringSeed = Readonly<{
    kind: 'managedRunLifecycle';
    source: AutomationRunLifecycleSource;
    project: WorkflowProjectTargetV1;
    actionTargets: readonly TriggerTargetV1[];
}>;
export type AutomationEventAuthoringSeed = PluginUiOpenAutomationEventRequestV1 | ManagedRunLifecycleAuthoringSeed;

export function storeAutomationEventAuthoringSeed(seed: AutomationEventAuthoringSeed, lifetime: ServerAccountScopeLifetime): string {
    return storeWorkflowEditorDraftSeed(KIND, seed, lifetime);
}

export function readAutomationEventAuthoringSeed(id: string, scope?: ServerAccountScope | null): AutomationEventAuthoringSeed | null {
    return readWorkflowEditorDraftSeed(KIND, id, scope);
}
