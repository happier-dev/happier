import { LEGACY_AUTOMATION_WORKFLOW_STEP_ID } from '@happier-dev/protocol/automations/automationLegacyWorkflowV1';
import { buildWorkflowSelectionFromServerStartSpawnDraftV1 } from '@happier-dev/protocol/workflows/workflowSessionAuthoringV1';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionPermissionModeInputSchema } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import type { AutomationRunExecutionTargetV1, AutomationRunTemplateV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';

import {
    buildWorkflowEditorDraftFromDefinition,
} from './workflowAuthoring';
import type { WorkflowEditorDraft } from './workflowEditorDraft';
import type { WorkflowAuthoringTarget } from './workflowProjectTarget';

/** Read-only current one-shot composer handoff. Retained 0.2 conversion belongs to Protocol. */
export type AutomationWorkflowEditorProjection = Readonly<{
    draft: WorkflowEditorDraft;
    origin: Readonly<{ kind: 'legacy'; target: AutomationRunExecutionTargetV1 }>;
    /** The exact placement the recipe already records, when it records one. */
    project: WorkflowAuthoringTarget | null;
}>;

/** The single step id an adapted one-shot recipe uses, matching editor-created ids. */
export { LEGACY_AUTOMATION_WORKFLOW_STEP_ID };

function legacyProject(
    target: AutomationRunExecutionTargetV1,
    machineId: string | null,
): WorkflowAuthoringTarget | null {
    if (target.kind === 'newSession') {
        const machineId = target.spawn.executionTarget.machineId;
        return target.spawn.directory.kind === 'path'
            ? { machineId, directory: target.spawn.directory.path }
            : { machineId, directory: target.spawn.directory };
    }
    return target.kind === 'executionRun' && machineId !== null && target.request.cwd
        ? { machineId, directory: target.request.cwd }
        : null;
}

/** Presentation of current one-shot targets, not retained-0.2 conversion authority. */
function oneShotExecutionSelection(
    target: AutomationRunExecutionTargetV1,
    machineId: string | null,
): WorkflowStepExecutionSelection {
    if (target.kind === 'existingSession') {
        return machineId === null ? {} : { conversation: { kind: 'existing_session', sessionId: target.sessionId, machineId } };
    }
    if (target.kind === 'newSession') {
        return { ...buildWorkflowSelectionFromServerStartSpawnDraftV1(target.spawn), conversation: { kind: 'fresh' } };
    }
    const request = target.request;
    return {
        agentTarget: AgentExecutionTargetV1Schema.parse(parseBackendTargetKeyV2(buildBackendTargetKeyV2(request.backendTarget))),
        permissionMode: SessionPermissionModeInputSchema.parse(request.permissionMode),
        ...(request.modelSelection ? { modelSelection: { v: 1, ref: request.modelSelection, updatedAt: 0 } }
            : request.modelId ? { modelSelection: { v: 1, ref: {
            agentTargetKey: buildBackendTargetKeyV2(request.backendTarget), providerConnectionId: null, modelId: request.modelId,
        }, updatedAt: 0 } } : {}),
        ...(request.sessionConfigOptionOverrides === undefined ? {} : { sessionConfigOptionOverrides: request.sessionConfigOptionOverrides }),
        ...(request.mcpSelection === undefined ? {} : { mcpSelection: request.mcpSelection }),
        ...(request.connectedServices === undefined ? {} : { connectedServices: request.connectedServices }),
        ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
        conversation: { kind: 'fresh' },
    };
}

/** Opens a current one-shot recipe as the canonical one-step Workflow draft. */
export function projectLegacyAutomationRecipeToEditorDraft(params: Readonly<{
    draftId: string;
    name: string;
    program: AutomationRunTemplateV1;
    target: AutomationRunExecutionTargetV1;
    /** The Automation's enabled assignment, used only where the target omits one. */
    machineId: string | null;
}>): AutomationWorkflowEditorProjection {
    return {
        draft: buildWorkflowEditorDraftFromDefinition({
            draftId: params.draftId,
            name: params.name,
            definition: { version: 1, inputs: [], defaults: oneShotExecutionSelection(params.target, params.machineId),
                blocks: [{ kind: 'step', id: LEGACY_AUTOMATION_WORKFLOW_STEP_ID,
                    document: { text: params.program.prompt, references: [...(params.program.mentions ?? [])], attachments: [] },
                    input: [], result: { kind: 'text' } }] },
        }),
        origin: { kind: 'legacy', target: params.target },
        project: legacyProject(params.target, params.machineId),
    };
}
