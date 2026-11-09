import * as React from 'react';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { setWorkflowDefaultField } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
  SessionAuthoringControls,
  type SessionAuthoringControlFacts,
} from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import {
  withWorkflowAuthoringEngine,
  withWorkflowAuthoringEngineFields,
} from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

const ENGINE_FIELDS = ['agentTarget', 'modelSelection'] as const;

/**
 * The workflow's own Agent and model picker: the editor's value line and Run review show this one control,
 * editing the draft's defaults as the draft is when chosen.
 */
export function WorkflowDefaultEngineControls(
  props: Readonly<{
    defaults: WorkflowEditorDraft['defaults'];
    roles: WorkflowEditorDraft['roles'];
    readDraft: () => WorkflowEditorDraft;
    onChange: (next: WorkflowEditorDraft) => void;
    editable: boolean;
    facts?: SessionAuthoringControlFacts;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const { readDraft, onChange, editable } = props;
  const values = React.useMemo(
    () =>
      resolveWorkflowStepSelectionV1({
        defaults: props.defaults,
        purpose: 'authoring',
      }).selection,
    [props.defaults],
  );
  const changeEngine = React.useCallback<
    NonNullable<
      React.ComponentProps<typeof SessionAuthoringControls>['onChangeEngine']
    >
  >(
    (engine) => {
      const draft = readDraft();
      if (editable)
        onChange({
          ...draft,
          defaults: withWorkflowAuthoringEngine(draft.defaults, engine),
        });
    },
    [editable, onChange, readDraft],
  );
  const changeFields = React.useCallback<
    NonNullable<
      React.ComponentProps<typeof SessionAuthoringControls>['onChangeFields']
    >
  >(
    (fields) => {
      const draft = readDraft();
      if (editable)
        onChange({
          ...draft,
          defaults: withWorkflowAuthoringEngineFields(draft.defaults, fields),
        });
    },
    [editable, onChange, readDraft],
  );
  const changeField = React.useCallback<
    React.ComponentProps<typeof SessionAuthoringControls>['onChangeField']
  >(
    (field, value) =>
      onChange(setWorkflowDefaultField(readDraft(), field, value)),
    [onChange, readDraft],
  );
  return (
    <SessionAuthoringControls
      disabled={!editable}
      fields={ENGINE_FIELDS}
      values={values}
      engine={props.defaults.engine}
      workflowRoles={props.roles}
      onChangeEngine={changeEngine}
      onChangeFields={changeFields}
      overriddenFields="all"
      onChangeField={changeField}
      {...(props.facts === undefined ? {} : { facts: props.facts })}
      testIDPrefix={props.testIDPrefix}
    />
  );
}
