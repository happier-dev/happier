import type { WorkflowSessionAuthoringSelection, WorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

function withoutEffort(selection: WorkflowStepSelectionV1): WorkflowStepSelectionV1 {
    const { sessionConfigOptionOverrides, ...rest } = selection;
    if (!sessionConfigOptionOverrides) return rest;
    const { reasoning_effort: _effort, ...overrides } = sessionConfigOptionOverrides.overrides;
    return { ...rest, sessionConfigOptionOverrides: { ...sessionConfigOptionOverrides, overrides } };
}

/** A Role or engine binding replaces (never competes with) the flat Agent, model and effort. */
export function withWorkflowAuthoringEngine(selection: WorkflowStepSelectionV1, engine: WorkflowEngineChoiceV1): WorkflowStepSelectionV1 {
    const { agentTarget: _agentTarget, modelSelection: _modelSelection, roleId: _roleId, engine: _binding, ...rest } = withoutEffort(selection);
    return 'roleId' in engine ? { ...rest, roleId: engine.roleId } : { ...rest, engine };
}

/** One atomic write from the shared Session picker: choosing an Agent replaces a Role or binding, as New Session does. */
export function withWorkflowAuthoringEngineFields(selection: WorkflowStepSelectionV1, fields: Partial<WorkflowSessionAuthoringSelection>): WorkflowStepSelectionV1 {
    if (!fields.agentTarget) return { ...selection, ...fields };
    const { roleId: _roleId, engine: _engine, modelSelection: _modelSelection, ...rest } = fields.sessionConfigOptionOverrides === undefined ? withoutEffort(selection) : selection;
    return { ...rest, ...fields };
}
