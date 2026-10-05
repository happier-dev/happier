import type { WorkflowEngineSelectionV1, WorkflowSessionAuthoringSelection, WorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowV1';

/** An engine arm replaces (never competes with) the retained flat authoring fields. */
export function withWorkflowAuthoringEngine(selection: WorkflowStepSelectionV1, engine: WorkflowEngineSelectionV1): WorkflowStepSelectionV1 {
    const { agentTarget, modelSelection, sessionConfigOptionOverrides, ...rest } = selection;
    if (!sessionConfigOptionOverrides) return { ...rest, engine };
    const { reasoning_effort, ...overrides } = sessionConfigOptionOverrides.overrides;
    return { ...rest, engine, sessionConfigOptionOverrides: { ...sessionConfigOptionOverrides, overrides } };
}

/** One atomic write from the shared Session picker into a Workflow's canonical engine arm. */
export function withWorkflowAuthoringEngineFields(selection: WorkflowStepSelectionV1, fields: Partial<WorkflowSessionAuthoringSelection>): WorkflowStepSelectionV1 {
    const next = { ...selection, ...fields };
    if (!fields.agentTarget) return next;
    const effort = fields.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value;
    return withWorkflowAuthoringEngine(next, {
        agentTarget: fields.agentTarget,
        modelSelection: fields.modelSelection ?? null,
        ...(typeof effort === 'string' && effort.length > 0 ? { effort } : {}),
    });
}
