import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import type { WorkflowDefinitionCaptureResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowDraftSettingsPatchV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkflowEditorDraft } from './workflowEditorDraft';
import type { WorkflowTriggerSnapshot } from '@/components/workflows/triggers/workflowTriggerDraft';
import type { WorkflowTriggerIncomplete } from '@/components/workflows/triggers/workflowTriggerStarts';

import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Unsaved authoring copy only: no Artifact identity or grants. Source selection is not placement. */
export type WorkflowDefinitionDraftSeed = Readonly<{
    name: string;
    description?: string;
    definition?: WorkflowDefinitionV1;
    /** A mounted authoring draft can be incomplete; only Save parses a stored definition. */
    draft?: WorkflowEditorDraft;
    /** Desired trigger rows and unfinished choices travel together through private navigation. */
    triggers?: WorkflowTriggerSnapshot;
    incompleteTriggers?: WorkflowTriggerIncomplete;
    trigger?: AutomationTriggerDefinitionInput;
    /** Event declaration retained with its trigger for local validation and history. */
    payloadSchema?: PluginJsonSchemaV2 | null;
    /** An unconfigured source stays with the ordinary When editor until enrollment completes. */
    eventSeed?: PluginUiOpenAutomationEventRequestV1;
    project?: WorkflowProjectTargetV1;
    executionTarget?: WorkflowDraftSettingsPatchV1['executionTarget'];
    /** The sentence and full editor share the same draft and Save. */
    initialView?: 'sentence';
    sessionTarget?: WorkflowStarterSessionTarget;
    /** Attribution stays out of the executable graph and never confers source access. */
    captureProvenance?: WorkflowDefinitionCaptureResultV1['provenance'];
}>;

const WORKFLOW_DEFINITION_DRAFT_SEED_KIND = 'workflow-definition-draft-seed';

export function storeWorkflowDefinitionDraftSeed(seed: WorkflowDefinitionDraftSeed, accountLifetime?: ServerAccountScopeLifetime | null): string {
    return storeWorkflowEditorDraftSeed(WORKFLOW_DEFINITION_DRAFT_SEED_KIND, seed, accountLifetime);
}

export function readWorkflowDefinitionDraftSeed(id: string, scope?: ServerAccountScope | null): WorkflowDefinitionDraftSeed | null {
    return readWorkflowEditorDraftSeed(WORKFLOW_DEFINITION_DRAFT_SEED_KIND, id, scope);
}
