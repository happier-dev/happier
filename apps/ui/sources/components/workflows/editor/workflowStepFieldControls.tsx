import * as React from 'react';

import type {
    WorkflowStepExecutionSelection,
} from '@happier-dev/protocol/workflows/workflowV1';

import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type {
    SessionAuthoringControlFacts,
    SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';

import type { WorkflowStepInspectorFieldId } from './WorkflowStepInspector';
import type { WorkflowEngineSelectionV1, WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol';

/**
 * Fills the step inspector's value seam with the shared Session-authoring
 * controls.
 *
 * The inspector keeps owning inherited/override state and the reset back to the
 * workflow default; this only supplies the control that edits the value, from
 * the same owner ordinary Session authoring uses. Choosing a value reports it
 * to the inspector — an explicit override, even when it equals the current
 * default — and nothing else: no navigation, no remembered selection.
 */

export type WorkflowStepFieldControlRenderer = (params: Readonly<{
    field: WorkflowStepInspectorFieldId;
    effective: WorkflowStepExecutionSelection;
    inheritance: 'inherited' | 'override';
    onChange: (value: WorkflowStepExecutionSelection[WorkflowStepInspectorFieldId] | undefined) => void;
    onChangeFields?: (fields: Partial<WorkflowSessionAuthoringSelection>) => void;
    engine?: WorkflowEngineSelectionV1;
    onChangeEngine?: (engine: WorkflowEngineSelectionV1) => void;
    workflowRoles?: readonly WorkflowRoleV1[];
}>) => React.ReactNode;

export function useWorkflowStepFieldControlRenderer(params: Readonly<{
    /** Host-owned option sources (Agent catalog, profiles, target platform…). */
    facts?: SessionAuthoringControlFacts;
    testIDPrefix?: string;
}> = {}): WorkflowStepFieldControlRenderer {
    const { facts, testIDPrefix } = params;
    return React.useCallback((renderParams) => (
        <SessionAuthoringControls
            fields={[renderParams.field as SessionAuthoringFieldId]}
            presentation="fields"
            values={renderParams.effective}
            engine={renderParams.engine} onChangeEngine={renderParams.onChangeEngine}
            onChangeFields={renderParams.onChangeFields}
            workflowRoles={renderParams.workflowRoles}
            onChangeField={(_field, value) => renderParams.onChange(value)}
            {...(facts === undefined ? {} : { facts })}
            testIDPrefix={testIDPrefix ?? 'workflow-inspector-control'}
        />
    ), [facts, testIDPrefix]);
}
