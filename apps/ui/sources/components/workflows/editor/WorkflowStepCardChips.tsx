import * as React from 'react';
import { View } from 'react-native';

import type {
  WorkflowStep,
  WorkflowStepExecutionSelection,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import type {
  SessionAuthoringControlFacts,
  SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { listWorkflowStepOverriddenFields } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import type { WorkflowStepOptionChange } from './useWorkflowStepOptionsSummary';
import { WorkflowStepOptionsMore } from './WorkflowStepOptionsChip';
import {
  isWorkflowStepEngineOverridden,
  WORKFLOW_ENGINE_FIELD_IDS,
} from './WorkflowStepInspector';
import { workflowEditorStyles } from './workflowEditorStyles';

const ENGINE_FIELDS: readonly SessionAuthoringFieldId[] = Object.freeze([
  'agentTarget',
]);
const ENGINE_CHANGED: ReadonlySet<SessionAuthoringFieldId> = new Set([
  'agentTarget',
]);

/** The Session fields a step sets itself, other than its engine: each is a bordered chip at its card's foot. */
export function listWorkflowStepSessionChanges(
  step: WorkflowStep,
): readonly SessionAuthoringFieldId[] {
  return listWorkflowStepOverriddenFields(step).filter(
    (field) =>
      !(WORKFLOW_ENGINE_FIELD_IDS as readonly string[]).includes(field),
  );
}

/**
 * An Agent step's header (round 1116b, step options A): its engine as the Session chip ("Claude ·
 * Opus 5.5"), quiet while the step inherits the workflow's and the bordered "Agent: …" chip once it
 * chooses its own. The same chip and picker the How card and the composer use.
 */
export function WorkflowStepEngineChip(
  props: Readonly<{
    draft: WorkflowEditorDraft;
    step: WorkflowStep;
    effective: WorkflowStepExecutionSelection;
    engine: WorkflowEngineChoiceV1 | undefined;
    editable: boolean;
    onChangeExecutionFields?: (
      fields: Partial<WorkflowStepExecutionSelection>,
    ) => void;
    onChangeEngine?: (engine: WorkflowEngineChoiceV1) => void;
    onResetEngine?: () => void;
    authoringFacts?: SessionAuthoringControlFacts;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const latest = React.useRef(props);
  latest.current = props;
  const onChangeFields = React.useCallback(
    (fields: Partial<WorkflowStepExecutionSelection>) =>
      latest.current.onChangeExecutionFields?.(fields),
    [],
  );
  const onChangeEngine = React.useCallback(
    (engine: WorkflowEngineChoiceV1) => latest.current.onChangeEngine?.(engine),
    [],
  );
  // A changed engine's picker leads with the way back to the workflow's.
  const resetOverride = React.useMemo(() => ({
    label: t('workflows.page.useWorkflowsValue'),
    onResetField: () => latest.current.onResetEngine?.(),
  }), []);
  return (
    <SessionAuthoringControls
      presentation="chips"
      fields={ENGINE_FIELDS}
      values={props.effective}
      {...(props.engine === undefined ? {} : { engine: props.engine })}
      workflowRoles={props.draft.roles}
      onChangeFields={onChangeFields}
      onChangeEngine={onChangeEngine}
      onChangeField={NO_FIELD_CHANGE}
      {...(isWorkflowStepEngineOverridden(props.step)
        ? { overriddenFields: ENGINE_CHANGED }
        : {})}
      overriddenAccessibilityHint={t('workflows.page.changedForStep')}
      resetOverride={resetOverride}
      disabled={!props.editable}
      {...(props.authoringFacts === undefined
        ? {}
        : { facts: props.authoringFacts })}
      testIDPrefix={props.testIDPrefix}
    />
  );
}

function NO_FIELD_CHANGE(): void {}

/**
 * The foot of an Agent step's card (round 1116b, step options A): only what the step changes, as
 * bordered chips, then "…" for the rest. A Session field opens its own picker; the step's other
 * options open the step's options beside the chip.
 */
export function WorkflowStepOptionChips(
  props: Readonly<{
    editable: boolean;
    step: WorkflowStep;
    effective: WorkflowStepExecutionSelection;
    changes: readonly WorkflowStepOptionChange[];
    onChangeExecutionField?: <
      TField extends keyof WorkflowStepExecutionSelection,
    >(
      field: TField,
      value: WorkflowStepExecutionSelection[TField] | undefined,
    ) => void;
    onOpenOptions: (anchorRef: React.RefObject<View | null>) => void;
    authoringFacts?: SessionAuthoringControlFacts;
    blockLabel: string;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const sessionFields = listWorkflowStepSessionChanges(props.step);
  const latest = React.useRef(props.onChangeExecutionField);
  latest.current = props.onChangeExecutionField;
  const onChangeField = React.useCallback(
    (field: SessionAuthoringFieldId, value: unknown) => {
      latest.current?.(field, value as never);
    },
    [],
  );
  const resetOverride = React.useMemo(() => ({
    label: t('workflows.page.useWorkflowsValue'),
    onResetField: (field: SessionAuthoringFieldId) => latest.current?.(field, undefined),
  }), []);
  return (
    <View style={workflowEditorStyles.stepOptionChips}>
      <View style={workflowEditorStyles.stepOptionChipList}>
        {sessionFields.length === 0 ? null : (
          <SessionAuthoringControls
            presentation="chips"
            fields={sessionFields}
            values={props.effective}
            onChangeField={onChangeField}
            overriddenFields="all"
            engineChipBeside
            disabled={!props.editable}
            overriddenAccessibilityHint={t('workflows.page.changedForStep')}
            resetOverride={resetOverride}
            {...(props.authoringFacts === undefined
              ? {}
              : { facts: props.authoringFacts })}
            testIDPrefix={`${props.testIDPrefix}-changed`}
          />
        )}
        {props.changes.map((change) => (
          <WorkflowStepOptionChangeChip
            key={change.id}
            change={change}
            onOpen={props.onOpenOptions}
            testID={`${props.testIDPrefix}-changed-${change.id}`}
          />
        ))}
      </View>
      <WorkflowStepOptionsMore
        onOpen={props.onOpenOptions}
        blockLabel={props.blockLabel}
        testID={`${props.testIDPrefix}-customize`}
      />
    </View>
  );
}

function WorkflowStepOptionChangeChip(
  props: Readonly<{
    change: WorkflowStepOptionChange;
    onOpen: (anchorRef: React.RefObject<View | null>) => void;
    testID: string;
  }>,
): React.ReactElement {
  const anchorRef = React.useRef<View>(null);
  return (
    <View ref={anchorRef} collapsable={false}>
      <SelectionListFilterChip
        filter={{
          id: props.change.id,
          testID: props.testID,
          label: props.change.title,
          // "Conversation: Fresh"; an option with no value of its own reads as its name.
          valueLabel: props.change.value ?? props.change.title,
          showLabel: props.change.value !== undefined,
          accessibilityHint: t('workflows.page.changedForStep'),
          open: false,
          onOpenChange: (next) => {
            if (next) props.onOpen(anchorRef);
          },
          renderPopoverContent: () => null,
        }}
      />
    </View>
  );
}
