import type { WorkflowStepExecutionSelection, WorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { replaceProviderModelCredentialBinding } from '@/sync/domains/teams/teamCredentialProviderModelSelection';

/** Drop the step's engine override so its complete engine inherits again. */
export function withoutWorkflowAuthoringEngine(selection: WorkflowStepSelectionV1 | undefined): WorkflowStepSelectionV1 {
    const { engine: _engine, roleId: _roleId, agentTarget: _agentTarget, modelSelection: _modelSelection,
        acpSessionModeId: _mode, sessionConfigOptionOverrides: _config, teamCredentialBindings, ...rest } = selection ?? {};
    const retained = replaceProviderModelCredentialBinding(teamCredentialBindings, null);
    return retained.length > 0 ? { ...rest, teamCredentialBindings: retained } : rest;
}

function withoutEffort(selection: WorkflowStepSelectionV1): WorkflowStepSelectionV1 {
    const { sessionConfigOptionOverrides, ...rest } = selection;
    if (!sessionConfigOptionOverrides) return rest;
    const { reasoning_effort: _effort, ...overrides } = sessionConfigOptionOverrides.overrides;
    return { ...rest, sessionConfigOptionOverrides: { ...sessionConfigOptionOverrides, overrides } };
}

/** A Role or engine binding replaces (never competes with) the flat Agent, model and effort. */
export function withWorkflowAuthoringEngine(selection: WorkflowStepSelectionV1, engine: WorkflowEngineChoiceV1): WorkflowStepSelectionV1 {
    const { agentTarget: _agentTarget, modelSelection: _modelSelection, roleId: _roleId, engine: _binding, ...rest } = withoutEffort(selection);
    const cleared = rest.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model')
        ? { ...rest, teamCredentialBindings: replaceProviderModelCredentialBinding(rest.teamCredentialBindings,
            { v: 1, slot: { kind: 'provider_model' }, resourceId: null }) } : rest;
    return 'roleId' in engine ? { ...cleared, roleId: engine.roleId } : { ...cleared, engine };
}

/** One atomic write from the shared Session picker: choosing an Agent replaces a Role or binding, as New Session does. */
export function withWorkflowAuthoringEngineFields(selection: WorkflowStepSelectionV1, fields: Partial<WorkflowStepExecutionSelection>): WorkflowStepSelectionV1 {
    if (!fields.agentTarget) return { ...selection, ...fields };
    const { roleId: _roleId, engine: _engine, modelSelection: _modelSelection, ...rest } = fields.sessionConfigOptionOverrides === undefined ? withoutEffort(selection) : selection;
    return { ...rest, ...fields };
}
