import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';
import type { WorkflowDefinitionCaptureResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import type { WorkflowDraftSettingsPatchV1 } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { WorkflowEditorDraft } from './workflowEditorDraft';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowTriggerSnapshot } from '@/components/workflows/triggers/workflowTriggerDraft';
import type { WorkflowTriggerAddRequestV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowTriggerIncomplete, WorkflowTriggerDraftSeedIntent, WorkflowTriggerStartContext } from '@/components/workflows/triggers/workflowTriggerStarts';

import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Unsaved authoring copy only: no Artifact identity or grants. Source selection is not placement. */
export type WorkflowDefinitionDraftSeed = Readonly<{
    name: string;
    description?: string;
    definition?: WorkflowDefinitionV1;
    /** A mounted authoring draft can be incomplete; only Save parses a stored definition. */
    draft?: WorkflowEditorDraft;
    /** Initial Run form values only; Save keeps them outside the reusable definition and triggers. */
    inputValues?: Readonly<Record<string, JsonValue>>;
    /** Desired trigger rows and unfinished choices travel together through private navigation. */
    triggers?: WorkflowTriggerSnapshot;
    incompleteTriggers?: WorkflowTriggerIncomplete;
    trigger?: AutomationTriggerDefinitionInput;
    /** Event declaration retained with its trigger for local validation and history. */
    payloadSchema?: PluginJsonSchemaV2 | null;
    /** An unconfigured source stays with the ordinary When editor until enrollment completes. */
    eventSeed?: WorkflowTriggerDraftSeedIntent['eventSeed'];
    /** Native source intent resolves after the author chooses a Runs-on controller. */
    nativeEvent?: WorkflowTriggerDraftSeedIntent['nativeEvent'];
    project?: WorkflowProjectTargetV1;
    /** Session lifetime is independent of the event's watched subject and execution placement. */
    lifetimeSession?: Extract<WorkflowTriggerAddRequestV1, { observationOnly?: never }>['lifetimeSession'];
    /** In-memory Session/resource intake follows the draft into the ordinary editor. */
    startContext?: WorkflowTriggerStartContext;
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

/** Open a private authoring copy. The regular editor owns saving it. */
export async function preparePluginWorkflowTemplateDraft(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    signal?: AbortSignal;
}> & (Readonly<{ workflow: string }> | Readonly<{ source: WorkflowPluginSourceV1; name?: string }>)) {
    const { accountLifetime, signal } = input;
    if (!accountLifetime.isCurrent()) return null;
    signal?.throwIfAborted();
    const source = 'source' in input ? input.source : await (async () => {
        const { listWorkflowDefinitions } = await import('./workflowDefinitionActions');
        const result = await listWorkflowDefinitions({ workflow: input.workflow, accountLifetime, signal });
        return result.pluginWorkflows?.[0];
    })();
    signal?.throwIfAborted();
    if (!source || !accountLifetime.isCurrent()) return null;
    const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({
        name: ('name' in input ? input.name : undefined) ?? source.title,
        ...(source.description === undefined ? {} : { description: source.description }),
        definition: source.definition,
        initialView: 'sentence',
    }, accountLifetime);
    return { pathname: '/workflows/new' as const, params: { definitionDraftSeedId, serverId: accountLifetime.scope.serverId } };
}
